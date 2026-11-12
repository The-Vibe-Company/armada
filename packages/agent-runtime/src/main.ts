import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { CODEX_ENDPOINT_ENV, parseCodexEndpoint } from "@armada/core";
import { runArtifactInstallMode } from "./artifact-cache.ts";
import { configureCodexEndpoint } from "./codex-endpoint.ts";
import {
  completeCredentialRepoint,
  prepareCredentialRepoint,
  scrubRepointCredentialFiles,
} from "./credential-repoint.ts";
import { execCredentialValues, validateExecEnvironment } from "./exec-env.ts";
import { GitHubBroker, type GitHubBrokerConfiguration } from "./github-broker.ts";
import { type installGitHubTools, prepareGitHubTools, runGitHubInstallMode } from "./github-tools.ts";
import { checkpointIdentityKey } from "./identity.ts";
import { ClaudeDriver, CodexDriver, type Grant, Journal, type McpConfiguration, Runner } from "./index.ts";
import { quiesceNativeCodex, readNativeCodexAuth } from "./native-auth.ts";
import type { ExecEnvironment } from "./protocol.ts";
import { createRedactor, HarnessState } from "./state.ts";

async function main() {
  // Bootstrap is delivered through a private stdin pipe, never argv or a golden file.
  const config = JSON.parse(await Bun.stdin.text()) as {
    root: string;
    cwd: string;
    port: number;
    grant: Grant;
    claudeExecutable: string;
    codexExecutable: string;
    claudeEnv: Record<string, string>;
    codexEnv: Record<string, string>;
    mcp?: McpConfiguration;
    ingestUrl: string;
    codexAuthJson?: string;
    credentialRepoint?: string;
    nativeAuthRevision?: number;
    nativeAuthSecrets?: string[];
    execEnv?: ExecEnvironment;
    credentialFreeBuilder?: boolean;
  };
  if (config.credentialFreeBuilder !== undefined && typeof config.credentialFreeBuilder !== "boolean")
    throw Error("invalid_exec_environment");
  const codexEndpoint = config.codexEnv[CODEX_ENDPOINT_ENV]
    ? parseCodexEndpoint(JSON.parse(config.codexEnv[CODEX_ENDPOINT_ENV]!))
    : undefined;
  delete config.codexEnv[CODEX_ENDPOINT_ENV];
  if (codexEndpoint) config.codexEnv.ARMADA_CUSTOM_CODEX_ENDPOINT = "1";
  const execEnv = validateExecEnvironment(config.execEnv, config.credentialFreeBuilder);
  if (
    config.credentialFreeBuilder &&
    (codexEndpoint ||
      config.codexAuthJson ||
      [config.claudeEnv, config.codexEnv].some((env) =>
        ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((key) =>
          Boolean(env[key]),
        ),
      ))
  )
    throw Error("builder_credentials_forbidden");
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  await chmod(config.root, 0o700);
  const authStrings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(authStrings)
        : [];
  const modelSecrets = [
    config.grant.token,
    ...[config.claudeEnv, config.codexEnv].flatMap((env) =>
      ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
        .map((key) => env[key])
        .filter((v): v is string => typeof v === "string"),
    ),
    ...(config.codexAuthJson ? authStrings(JSON.parse(config.codexAuthJson)) : []),
  ];
  if (execCredentialValues(execEnv).some((value) => modelSecrets.includes(value)))
    throw Error("invalid_exec_environment");
  const secrets = [
    ...(config.nativeAuthSecrets ?? []),
    config.grant.token,
    ...execCredentialValues(execEnv),
    ...(config.codexAuthJson ? [config.codexAuthJson, ...authStrings(JSON.parse(config.codexAuthJson))] : []),
    ...Object.entries(config.claudeEnv)
      .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD/.test(key))
      .map(([, value]) => value),
    ...Object.entries(config.codexEnv)
      .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD/.test(key))
      .map(([, value]) => value),
    ...Object.values(config.mcp?.servers ?? {}).flatMap((v) =>
      v.type === "http"
        ? [v.url, ...Object.values(v.headers ?? {})]
        : [...(v.args ?? []), ...Object.values(v.env ?? {})],
    ),
  ]
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);
  const redact = createRedactor(secrets);
  const journal = new Journal(`${config.root}/journal.sqlite`, redact);
  let lastAuth: string | undefined;
  const refreshNativeSecrets = () => {
    const current = readNativeCodexAuth(config.root, (values) => journal.registerSecrets(values));
    if (current !== lastAuth) {
      lastAuth = current;
      journal.sanitize();
    }
  };
  const receiptKey = `native-auth:checkpoint-ack:${checkpointIdentityKey(config.grant)}`;
  const publishNativeAuth = async (checkpoint = false, observedAuth?: string) => {
    // Private generation-bound publication must be acknowledged before auth is scrubbed.
    if (config.nativeAuthRevision !== undefined) {
      let committed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const authJson = observedAuth ?? readNativeCodexAuth(config.root, (values) => journal.registerSecrets(values));
        if (!authJson) {
          // A generation-scoped durable ACK survives a lost checkpoint response
          // and runner restart after the corresponding native home was scrubbed.
          const receipt = journal.db.query("SELECT value FROM metadata WHERE key=?").get(receiptKey);
          if (checkpoint && receipt && journal.checkpointPending(config.grant)) return;
          throw Error("native_auth_publication_missing");
        }
        if (
          !config.codexAuthJson ||
          JSON.parse(authJson).tokens?.account_id !== JSON.parse(config.codexAuthJson).tokens?.account_id
        )
          throw Error("native_auth_identity_changed");
        const response = await fetch(config.ingestUrl, {
          redirect: "error",
          method: "POST",
          headers: { "content-type": "application/json", "x-armada-runner-grant": config.grant.token },
          body: JSON.stringify({
            sandboxId: config.grant.sandboxId,
            generation: config.grant.generation,
            events: [],
            nativeAuth: { authJson, expectedRevision: config.nativeAuthRevision },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("native_auth_publication_unknown");
        const receipt = (await response.json()) as { authRevision: number; committed: boolean };
        if (
          !Number.isSafeInteger(receipt.authRevision) ||
          receipt.authRevision < config.nativeAuthRevision ||
          typeof receipt.committed !== "boolean"
        )
          throw Error("native_auth_publication_unknown");
        config.nativeAuthRevision = receipt.authRevision;
        if (receipt.committed) {
          if (checkpoint)
            journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(
              receiptKey,
              JSON.stringify({
                revision: receipt.authRevision,
                digest: createHash("sha256").update(authJson).digest("hex"),
              }),
            );
          journal.flush();
          committed = true;
          break;
        }
      }
      if (!committed) throw Error("native_auth_publication_conflict");
    }
  };
  const state = new HarnessState(config.root, journal.redact);
  const sourceIdentity = journal.assertRestoreSource(config.grant);
  const fenced = journal.checkpointPending(config.grant);
  let survivingAuth: string | undefined;
  const resetCredentials =
    !fenced &&
    (await prepareCredentialRepoint(
      config.root,
      config.credentialRepoint,
      (values) => journal.registerSecrets(values),
      () => journal.sanitize(),
    ));
  if (!fenced && !resetCredentials && config.nativeAuthRevision !== undefined) {
    await quiesceNativeCodex(config.root, config.codexExecutable);
    survivingAuth = readNativeCodexAuth(config.root, (values) => journal.registerSecrets(values));
    if (survivingAuth) {
      if (!sourceIdentity || checkpointIdentityKey(sourceIdentity) !== checkpointIdentityKey(config.grant))
        throw Error("native_auth_source_ambiguous");
      // Publish before restore can collect transcripts or destroy the only live
      // refresh token. Failure leaves the source file intact and boot unready.
      await publishNativeAuth(false, survivingAuth);
      config.codexAuthJson = survivingAuth;
      journal.sanitize();
    }
  }
  if (!fenced) await state.restore(config.grant, sourceIdentity);
  if (!fenced) {
    await rm(`${config.root}/exec-transient`, { recursive: true, force: true });
    await mkdir(`${config.root}/exec-transient/gh`, { recursive: true, mode: 0o700 });
    // Private HOME catches legacy ~/.claude.json, XDG caches and refreshed native auth.
    for (const [harness, env] of [
      ["claude", config.claudeEnv],
      ["codex", config.codexEnv],
    ] as const) {
      env.HOME = `${config.root}/${harness}/home`;
      env.XDG_CONFIG_HOME = `${env.HOME}/.config`;
      env.XDG_CACHE_HOME = `${env.HOME}/.cache`;
      env.XDG_DATA_HOME = `${env.HOME}/.local/share`;
      await mkdir(env.HOME, { recursive: true, mode: 0o700 });
    }
    if (resetCredentials) await scrubRepointCredentialFiles(config.root);
    config.claudeEnv.CLAUDE_CONFIG_DIR = `${config.root}/claude`;
    config.codexEnv.CODEX_HOME = `${config.root}/codex`;
    await configureCodexEndpoint(config.codexEnv.CODEX_HOME, codexEndpoint);
    if (config.codexAuthJson) await writeFile(`${config.root}/codex/auth.json`, config.codexAuthJson, { mode: 0o600 });
  }
  const github = new GitHubBroker((values) => journal.registerSecrets(values));
  const githubRoot = `${config.root}/github-${createHash("sha256").update(config.grant.generation).digest("hex").slice(0, 16)}`;
  let githubSocket: Awaited<ReturnType<GitHubBroker["listen"]>> | undefined;
  let githubConfiguration = Promise.resolve();
  const configureGitHub = (value: GitHubBrokerConfiguration | null): Promise<void> => {
    const work = githubConfiguration.then(async () => {
      github.configure(value);
      if (!value) return;
      try {
        githubSocket ??= await github.listen(githubRoot);
        const tools: Parameters<typeof installGitHubTools>[0] = {
          root: githubRoot,
          socket: githubSocket.socket,
          gh: "/usr/bin/gh",
          git: "/usr/bin/git",
          ghWrapper: "/usr/local/bin/gh",
          gitWrapper: "/usr/local/bin/git",
          homes: ["/home/user", config.claudeEnv.HOME!, config.codexEnv.HOME!],
          activation: githubSocket.activation,
        };
        await prepareGitHubTools(tools);
      } catch {
        github.configure(null);
        throw Error("github_configuration_denied");
      }
    });
    githubConfiguration = work.catch(() => {});
    return work;
  };
  const runner = new Runner(
    journal,
    config.grant,
    {
      claude: new ClaudeDriver({ cwd: config.cwd, executable: config.claudeExecutable, env: config.claudeEnv }),
      codex: new CodexDriver({
        cwd: config.cwd,
        executable: config.codexExecutable,
        env: config.codexEnv,
        refreshSecrets: refreshNativeSecrets,
        exclusiveAuth: config.nativeAuthRevision !== undefined,
      }),
    },
    {
      async append(batch) {
        const response = await fetch(config.ingestUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-armada-runner-grant": config.grant.token },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("ingest_failed");
        try {
          return (await response.json()) as { acknowledgedSequence: number };
        } catch {
          throw Error("invalid_ingest_ack");
        }
      },
    },
    fenced ? undefined : config.mcp,
    async () => {
      await publishNativeAuth(true);
      await state.checkpoint(config.grant);
      await rm(`${config.root}/exec-transient`, { recursive: true, force: true });
      journal.sanitize();
    },
    {
      configureGitHub,
      execEnv: fenced ? {} : execEnv,
      refreshNativeSecrets,
      publishNativeAuth,
      exclusiveNativeAuth: config.nativeAuthRevision !== undefined,
      credentialFreeBuilder: config.credentialFreeBuilder ?? false,
      ghConfigDir: `${config.root}/exec-transient/gh`,
    },
  );
  if (!fenced) await completeCredentialRepoint(config.root, config.credentialRepoint);
  Bun.serve({
    hostname: "0.0.0.0",
    port: config.port,
    fetch: (request) => runner.handle(request),
    maxRequestBodySize: 1048576,
  });

  setInterval(() => {
    void runner.flushOutbox().catch(() => {});
  }, 1000).unref();
}
void (
  process.argv[2] === "github-install"
    ? runGitHubInstallMode()
    : process.argv[2] === "install-artifact"
      ? runArtifactInstallMode()
      : main()
).catch(() => {
  process.stderr.write("runner_boot_failed\n");
  process.exitCode = 1;
});
