import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { execCredentialValues, validateExecEnvironment } from "./exec-env.ts";
import { GitHubBroker, type GitHubBrokerConfiguration } from "./github-broker.ts";
import { type installGitHubTools, prepareGitHubTools, runGitHubInstallMode } from "./github-tools.ts";
import { ClaudeDriver, CodexDriver, type Grant, Journal, type McpConfiguration, Runner } from "./index.ts";
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
    execEnv?: ExecEnvironment;
    credentialFreeBuilder?: boolean;
  };
  if (config.credentialFreeBuilder !== undefined && typeof config.credentialFreeBuilder !== "boolean")
    throw Error("invalid_exec_environment");
  const execEnv = validateExecEnvironment(config.execEnv, config.credentialFreeBuilder);
  if (
    config.credentialFreeBuilder &&
    (config.codexAuthJson ||
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
  const state = new HarnessState(config.root, journal.redact);
  const sourceIdentity = journal.assertRestoreSource(config.grant);
  const fenced = journal.checkpointPending(config.grant);
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
    config.claudeEnv.CLAUDE_CONFIG_DIR = `${config.root}/claude`;
    config.codexEnv.CODEX_HOME = `${config.root}/codex`;
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
      codex: new CodexDriver({ cwd: config.cwd, executable: config.codexExecutable, env: config.codexEnv }),
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
      await state.checkpoint(config.grant);
      await rm(`${config.root}/exec-transient`, { recursive: true, force: true });
      journal.sanitize();
    },
    {
      configureGitHub,
      execEnv: fenced ? {} : execEnv,
      credentialFreeBuilder: config.credentialFreeBuilder ?? false,
      ghConfigDir: `${config.root}/exec-transient/gh`,
    },
  );
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
void (process.argv[2] === "github-install" ? runGitHubInstallMode() : main()).catch(() => {
  process.stderr.write("runner_boot_failed\n");
  process.exitCode = 1;
});
