import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import {
  CODEX_ENDPOINT_ENV,
  HARNESS_CAPABILITIES,
  isHarness,
  OPENCODE_ENDPOINT_ENV,
  parseCodexEndpoint,
  parseOpenCodeEndpoint,
} from "@armada/core";
import { antigravitySecrets } from "@armada/core/antigravity-credential";
import { runtimeOperatorDiagnostic } from "../../core/src/runtime-operator-diagnostic.ts";
import { runtimeStartupFailure } from "../../core/src/runtime-startup-failure.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { runArtifactInstallMode } from "./artifact-cache.ts";
import { configureClaudeEndpoint } from "./claude-endpoint.ts";
import { enrolRuntime, RuntimeDialout, runtimeSubscriptionAccess } from "./dialout.ts";
import {
  bootstrapGitHubHomes,
  initializeBootstrapHarnessHomes,
  prepareEnrolledHarness,
  selectBootstrapHarnesses,
  shouldPrepareLocalOpenCode,
} from "./enrolled-harness.ts";
import { execCredentialValues, validateExecEnvironment, validateExecReadables } from "./exec-env.ts";
import { GitHubBroker, type GitHubBrokerConfiguration } from "./github-broker.ts";
import { runGitHubClient } from "./github-client.ts";
import { githubRuntimeEnvironment, installUserGitHubTools, runGitHubInstallMode } from "./github-tools.ts";
import { runHarnessInstallMode } from "./harness-cache.ts";
import { checkpointIdentityKey } from "./identity.ts";
import { ClaudeDriver, CodexDriver, type Grant, Journal, type McpConfiguration, Runner } from "./index.ts";
import { runtimeModelConnection, testModelConnection } from "./model-connection-test.ts";
import {
  createNativeAuthRefresher,
  quiesceNativeCodex,
  readNativeCodexAuth,
  removeNativeCodexAuth,
} from "./native-auth.ts";
import { OpenCodeDriver } from "./opencode.ts";
import { configureOpenCodeEndpoint } from "./opencode-endpoint.ts";
import { prepareOpenCode } from "./opencode-install.ts";
import type { ExecEnvironment } from "./protocol.ts";
import { createRuntimeRelay } from "./relay-client.ts";
import { createRedactor, HarnessState } from "./state.ts";

let startupReason: import("../../core/src/runtime-startup-failure.ts").RuntimeStartupFailure = "runtime_configuration";
let reportRuntimeFailure: ((error: unknown) => Promise<void>) | undefined;
let closeGitHubBroker: (() => Promise<void>) | undefined;

async function main(dialout = false) {
  // Bootstrap is delivered through a private stdin pipe, never argv or a golden file.
  const input = JSON.parse(await Bun.stdin.text());
  const enrolled = dialout ? await enrolRuntime(input) : undefined;
  const channel = enrolled ? new RuntimeDialout(input.serverUrl, enrolled) : undefined;
  if (channel) {
    reportRuntimeFailure = (error) =>
      channel.progress("runtime_failed", startupReason, runtimeOperatorDiagnostic(error)).catch(() =>
        // Older servers accept the closed startup reason without the diagnostic extension.
        channel.progress("runtime_failed", startupReason),
      );
    await channel.progress("enrolled").catch(() => {});
  }
  const config = (enrolled ? enrolled.configuration : input) as {
    root: string;
    cwd: string;
    port: number;
    grant: Grant;
    opencodeExecutable?: string;
    opencodeEnv?: Record<string, string>;
    antigravityCredential?: unknown;
    claudeExecutable: string;
    codexExecutable: string;
    selectedHarness?: unknown;
    restoreCheckpoint?: {
      epoch: string;
      watermark: number;
      conversationId: string | null;
      model: string;
      reasoningEffort: string;
    };
    artifactManifest?: unknown;
    claudeEnv: Record<string, string>;
    codexEnv: Record<string, string>;
    mcp?: McpConfiguration;
    ingestUrl: string;
    codexAuthJson?: string;
    runtimeSubscription?: boolean;
    subscription?: { url: string; capability: string };
    nativeAuthRevision?: number;
    nativeAuthSecrets?: string[];
    execEnv?: ExecEnvironment;
    readableVariables?: Record<string, string>;
    credentialFreeBuilder?: boolean;
  };
  let antigravity: Awaited<ReturnType<typeof prepareEnrolledHarness>>["antigravity"];
  if (enrolled) {
    // Enrolment owns selection and credentials. Never trust a preinstalled CLI
    // path from the image, or install/change harness versions during commands.
    startupReason = "artifact_preparation";
    const { antigravity: preparedAntigravity, ...preparedHarness } = await prepareEnrolledHarness(
      input.serverUrl,
      config,
    );
    antigravity = preparedAntigravity;
    Object.assign(config, preparedHarness);
    config.grant = {
      token: enrolled.runtimeToken,
      sandboxId: enrolled.sandboxId,
      generation: enrolled.epoch,
      expiresAt: config.grant.expiresAt,
    };
  }
  startupReason = "credential_projection";
  const opencodeEnv = config.opencodeEnv ?? {};
  if (config.credentialFreeBuilder !== undefined && typeof config.credentialFreeBuilder !== "boolean")
    throw Error("invalid_exec_environment");
  if (config.runtimeSubscription !== undefined && typeof config.runtimeSubscription !== "boolean")
    throw Error("invalid_runtime_subscription");
  if (
    config.runtimeSubscription &&
    (!channel ||
      config.selectedHarness !== "codex" ||
      config.credentialFreeBuilder ||
      config.subscription ||
      config.codexAuthJson ||
      config.nativeAuthRevision !== undefined ||
      config.codexEnv.OPENAI_API_KEY ||
      config.codexEnv[CODEX_ENDPOINT_ENV])
  )
    throw Error("invalid_runtime_subscription");
  if (config.subscription && config.codexAuthJson) throw Error("subscription_auth_modes_conflict");
  startupReason = "model_routing";
  const codexEndpoint = config.codexEnv[CODEX_ENDPOINT_ENV]
    ? parseCodexEndpoint(JSON.parse(config.codexEnv[CODEX_ENDPOINT_ENV]!))
    : undefined;
  delete config.codexEnv[CODEX_ENDPOINT_ENV];
  if (codexEndpoint) config.codexEnv.ARMADA_CUSTOM_CODEX_ENDPOINT = "1";
  configureClaudeEndpoint(config.claudeEnv);
  startupReason = "runtime_configuration";
  const execEnv = validateExecEnvironment(config.execEnv, config.credentialFreeBuilder);
  const readableVariables = validateExecReadables(config.readableVariables, config.credentialFreeBuilder);
  if (
    config.credentialFreeBuilder &&
    (codexEndpoint ||
      antigravity ||
      config.codexAuthJson ||
      [config.claudeEnv, config.codexEnv, opencodeEnv].some((env) =>
        [
          "OPENCODE_API_KEY",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "GH_TOKEN",
          "GITHUB_TOKEN",
        ].some((key) => Boolean(env[key])),
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
  const antigravityCredential = antigravity?.credential;
  const antigravitySecretValues = antigravityCredential ? antigravitySecrets(antigravityCredential) : [];
  const modelSecrets = [
    config.grant.token,
    ...antigravitySecretValues,
    ...[config.claudeEnv, config.codexEnv, opencodeEnv].flatMap((env) =>
      ["OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
        .map((key) => env[key])
        .filter((v): v is string => typeof v === "string"),
    ),
    ...(config.codexAuthJson ? authStrings(JSON.parse(config.codexAuthJson)) : []),
  ];
  if (execCredentialValues(execEnv).some((value) => modelSecrets.includes(value)))
    throw Error("invalid_exec_environment");
  const secrets = [
    ...(config.nativeAuthSecrets ?? []),
    ...antigravitySecretValues,
    ...(config.subscription ? [config.subscription.capability] : []),
    config.grant.token,
    ...execCredentialValues(execEnv),
    ...(config.codexAuthJson ? [config.codexAuthJson, ...authStrings(JSON.parse(config.codexAuthJson))] : []),
    ...Object.entries(opencodeEnv)
      .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD/.test(key))
      .map(([, value]) => value),
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
  const opencodeConnection =
    opencodeEnv[OPENCODE_ENDPOINT_ENV] && opencodeEnv.OPENCODE_API_KEY
      ? {
          harness: "opencode" as const,
          endpoint: parseOpenCodeEndpoint(JSON.parse(opencodeEnv[OPENCODE_ENDPOINT_ENV]!)),
          apiKey: opencodeEnv.OPENCODE_API_KEY,
        }
      : null;
  configureOpenCodeEndpoint(opencodeEnv);
  const journal = new Journal(`${config.root}/journal.sqlite`, redact);
  const refreshNativeSecrets =
    (config.nativeAuthRevision !== undefined || Boolean(config.codexAuthJson)) &&
    !config.subscription &&
    !config.runtimeSubscription
      ? createNativeAuthRefresher(
          config.root,
          (values) => journal.registerSecrets(values),
          () => journal.sanitize(),
        )
      : undefined;
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
        let receipt: { authRevision: number; committed: boolean };
        if (channel)
          receipt = await channel.publishNativeAuth({ authJson, expectedRevision: config.nativeAuthRevision });
        else {
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
          receipt = (await response.json()) as { authRevision: number; committed: boolean };
        }
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
  const state = new HarnessState(config.root, journal.redact, (text) => journal.redact(text, "transcript"));
  const sourceIdentity = journal.assertRestoreSource(config.grant);
  const restore = config.restoreCheckpoint;
  if (restore) {
    if (
      !enrolled ||
      !isHarness(config.selectedHarness) ||
      !HARNESS_CAPABILITIES[config.selectedHarness].resume ||
      !/^[1-9][0-9]{0,18}$/.test(restore.epoch) ||
      (restore.conversationId !== null && (typeof restore.conversationId !== "string" || !restore.conversationId)) ||
      typeof restore.model !== "string" ||
      !restore.model ||
      typeof restore.reasoningEffort !== "string"
    )
      throw Error("invalid_runtime_restore");
    journal.requireCheckpoint(
      { sandboxId: config.grant.sandboxId, generation: restore.epoch },
      restore.watermark,
      restore.conversationId,
    );
  }
  const fenced = journal.checkpointPending(config.grant);
  let survivingAuth: string | undefined;
  if (!fenced && (config.subscription || config.runtimeSubscription)) {
    await quiesceNativeCodex(config.root, config.codexExecutable);
    readNativeCodexAuth(config.root, (values) => journal.registerSecrets(values));
    journal.sanitize();
  }
  if (!fenced && !config.subscription && config.nativeAuthRevision !== undefined) {
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
  if (!fenced)
    await state.restore(
      config.grant,
      sourceIdentity,
      restore ? { sandboxId: config.grant.sandboxId, generation: restore.epoch } : undefined,
    );
  const activeHarnesses = selectBootstrapHarnesses(Boolean(enrolled), config.selectedHarness);
  const activeHarnessSet = new Set(activeHarnesses);
  const harnessEnvs = {
    opencode: opencodeEnv,
    claude: config.claudeEnv,
    codex: config.codexEnv,
  };
  if (!fenced) {
    await rm(`${config.root}/exec-transient`, { recursive: true, force: true });
    await mkdir(`${config.root}/exec-transient/gh`, { recursive: true, mode: 0o700 });
    // Private HOME catches legacy ~/.claude.json, XDG caches and refreshed native auth.
    await initializeBootstrapHarnessHomes({
      root: config.root,
      harnesses: activeHarnesses,
      envs: harnessEnvs,
      execEnv,
      codexEndpoint,
    });
    if (config.subscription || config.runtimeSubscription) {
      removeNativeCodexAuth(config.root, (values) => journal.registerSecrets(values));
      journal.sanitize();
    } else if (activeHarnessSet.has("codex") && config.codexAuthJson)
      await writeFile(`${config.root}/codex/auth.json`, config.codexAuthJson, { mode: 0o600 });
  }
  const subscriptionRevisions = new Map<string, number>();
  let subscriptionAccess = config.subscription
    ? async (refresh: boolean, previousAccessToken?: string) => {
        const response = await fetch(config.subscription!.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.subscription!.capability}` },
          body: JSON.stringify(
            refresh && previousAccessToken ? { previousRevision: subscriptionRevisions.get(previousAccessToken) } : {},
          ),
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) throw Error("subscription_access_unavailable");
        const access = (await response.json()) as {
          accessToken: string;
          chatgptAccountId: string;
          chatgptPlanType: string | null;
          revision: number;
        };
        if (
          typeof access.accessToken !== "string" ||
          typeof access.chatgptAccountId !== "string" ||
          !Number.isSafeInteger(access.revision)
        )
          throw Error("subscription_access_invalid");
        journal.registerSecrets([access.accessToken]);
        subscriptionRevisions.set(access.accessToken, access.revision);
        return {
          accessToken: access.accessToken,
          chatgptAccountId: access.chatgptAccountId,
          chatgptPlanType: access.chatgptPlanType,
        };
      }
    : undefined;
  if (config.runtimeSubscription && channel)
    subscriptionAccess = runtimeSubscriptionAccess(channel, (values) => journal.registerSecrets(values));
  const github = new GitHubBroker((values) => journal.registerSecrets(values));
  const githubRoot = `${config.root}/github-${createHash("sha256").update(config.grant.generation).digest("hex").slice(0, 16)}`;
  const githubBin = `${githubRoot}/bin`;
  const githubHome = execEnv.HOME ?? process.env.HOME ?? "/home/user";
  // Fixed before drivers/exec capture their environments. Installation contains no secrets.
  for (const harness of activeHarnesses)
    Object.assign(harnessEnvs[harness], githubRuntimeEnvironment(harnessEnvs[harness], githubRoot));
  Object.assign(process.env, githubRuntimeEnvironment({ PATH: process.env.PATH }, githubRoot));
  let githubSocket: Awaited<ReturnType<GitHubBroker["listen"]>> | undefined;
  let githubClosing = false;
  const closeBroker = () => {
    githubClosing = true;
    return github.close();
  };
  closeGitHubBroker = closeBroker;
  const stopDuringStartup = (signal: NodeJS.Signals) => {
    removeStartupSignalHandlers();
    void closeBroker()
      .catch(() => process.stderr.write("github_socket_cleanup_failed\n"))
      .then(() => process.kill(process.pid, signal));
  };
  const removeStartupSignalHandlers = () => {
    process.removeListener("SIGTERM", stopDuringStartup);
    process.removeListener("SIGINT", stopDuringStartup);
  };
  process.once("SIGTERM", stopDuringStartup);
  process.once("SIGINT", stopDuringStartup);
  let githubConfiguration = Promise.resolve();
  const ensureGitHubTools = async (identity?: { name: string; email: string }) => {
    if (githubClosing) throw Error("github_configuration_denied");
    githubSocket = await github.listen();
    const tools: Parameters<typeof installUserGitHubTools>[0] = {
      root: githubRoot,
      socket: githubSocket.socket,
      gh: "/usr/bin/gh",
      git: "/usr/bin/git",
      homes: bootstrapGitHubHomes(githubHome, activeHarnesses, harnessEnvs),
      activation: githubSocket.activation,
      ...(identity ? { identity } : {}),
    };
    await installUserGitHubTools(tools);
  };
  const configureGitHub = (value: GitHubBrokerConfiguration | null): Promise<void> => {
    const work = githubConfiguration.then(async () => {
      github.configure(value);
      if (!value) return;
      try {
        await ensureGitHubTools(value.identity);
      } catch {
        github.configure(null);
        throw Error("github_configuration_denied");
      }
    });
    githubConfiguration = work.catch(() => {});
    return work;
  };
  // Previous-epoch wrappers cannot point at a dead socket during native restore.
  // Rebind redaction-only IPC first; no GitHub credential authority is restored.
  if (enrolled) await ensureGitHubTools();
  const opencodeExecutable = shouldPrepareLocalOpenCode(Boolean(enrolled), opencodeEnv)
    ? await prepareOpenCode({
        candidate: config.opencodeExecutable ?? "/usr/local/bin/opencode",
        serverUrl: new URL(config.ingestUrl).origin,
        cacheDir: `${config.root}/.harness-cache`,
      })
    : (config.opencodeExecutable ?? "/usr/local/bin/opencode");
  const runtimeExecEnv = {
    ...(fenced ? {} : execEnv),
    PATH: `${githubBin}:${execEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  };
  const drivers: ConstructorParameters<typeof Runner>[2] = {};
  if (antigravity && !fenced)
    drivers.antigravity = new AntigravityDriver({
      ...antigravity,
      readableVariables,
      githubTools: { root: githubRoot, home: githubHome },
      root: config.root,
      cwd: config.cwd,
      journal,
      redactToolText: (text) => journal.redactLiteralText(text),
    });
  if (activeHarnessSet.has("opencode"))
    drivers.opencode = new OpenCodeDriver({
      executable: opencodeExecutable,
      root: `${config.root}/opencode`,
      cwd: config.cwd,
      env: opencodeEnv,
      redact: (text) => journal.redact(text, "transcript"),
      redactToolText: (text) => journal.redactLiteralText(text),
    });
  if (activeHarnessSet.has("claude"))
    drivers.claude = new ClaudeDriver({ cwd: config.cwd, executable: config.claudeExecutable, env: config.claudeEnv });
  if (activeHarnessSet.has("codex"))
    drivers.codex = new CodexDriver({
      cwd: config.cwd,
      executable: config.codexExecutable,
      env: config.codexEnv,
      ...(refreshNativeSecrets ? { refreshSecrets: refreshNativeSecrets } : {}),
      ...(channel ? { onStarted: () => void channel.progress("harness_started").catch(() => {}) } : {}),
      exclusiveAuth: config.nativeAuthRevision !== undefined,
      ...(subscriptionAccess ? { subscriptionAccess } : {}),
    });
  const runner = new Runner(
    journal,
    config.grant,
    drivers,
    channel ?? {
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
      ...(channel
        ? {
            enrolled: true,
            reportHarnessFailure: (stage, error, requestId, reason) => {
              void channel
                .progress(stage, undefined, runtimeOperatorDiagnostic(error, reason), requestId)
                .catch(() => {});
            },
          }
        : {}),
      prepareWorkspace: async () => {
        if (!githubSocket) await ensureGitHubTools();
      },
      ...(restore
        ? {
            restoredFrom: {
              epoch: restore.epoch,
              watermark: restore.watermark,
              conversationId: restore.conversationId,
            },
          }
        : {}),
      testModelConnection: async (harness, model, signal) => {
        if (harness === "opencode") {
          if (!opencodeConnection) throw Error("model_connection_test_denied");
          return testModelConnection(opencodeConnection, model, signal);
        }
        const connection = runtimeModelConnection(
          harness,
          harness === "codex" ? config.codexEnv : config.claudeEnv,
          codexEndpoint,
        );
        if (connection) return testModelConnection(connection, model, signal);
        throw Error("model_connection_test_denied");
      },
      readableVariables: fenced ? {} : readableVariables,
      execEnv: runtimeExecEnv,
      ...(refreshNativeSecrets ? { refreshNativeSecrets } : {}),
      publishNativeAuth,
      exclusiveNativeAuth: config.nativeAuthRevision !== undefined,
      credentialFreeBuilder: config.credentialFreeBuilder ?? false,
      ghConfigDir: `${config.root}/exec-transient/gh`,
      githubToolsRoot: githubRoot,
    },
  );
  if (restore && restore.conversationId !== null) {
    const session = journal.session(restore.conversationId);
    if (!session) throw Error("resume_checkpoint_mismatch");
    const response = await runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": config.grant.token },
        body: JSON.stringify({
          version: 1,
          sandboxId: config.grant.sandboxId,
          requestId: `restore_${config.grant.generation}`,
          op: "resumeNativeSession",
          conversationId: restore.conversationId,
          expectedSessionId: session,
          input: {
            sandboxId: config.grant.sandboxId,
            harness: config.selectedHarness,
            model: restore.model,
            reasoningEffort: restore.reasoningEffort,
            cwd: config.cwd,
          },
        }),
      }),
    );
    const body = (await response.json()) as {
      result?: { nativeSessionId?: string; physicalGeneration?: string; conversationId?: string; verified?: boolean };
    };
    if (
      response.status !== 200 ||
      body.result?.verified !== true ||
      body.result.nativeSessionId !== session ||
      body.result.physicalGeneration !== config.grant.generation ||
      body.result.conversationId !== restore.conversationId
    )
      throw Error("runtime_native_restore_failed");
  }
  runner.startOutboxDelivery();
  if (githubClosing) return;
  removeStartupSignalHandlers();
  if (channel) {
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    let closing: Promise<void> | undefined;
    const requests = new Set<Promise<Response>>();
    const relay = createRuntimeRelay(input.serverUrl, enrolled, {
      cwd: config.cwd,
      execEnv: runtimeExecEnv,
      ghConfigDir: `${config.root}/exec-transient/gh`,
      githubToolsRoot: githubRoot,
      credentialFreeBuilder: config.credentialFreeBuilder,
    });
    const closeNative = () => {
      closing ??= Promise.resolve().then(async () => {
        stop.abort();
        relay?.close();
        github.configure(null);
        try {
          await closeBroker();
        } finally {
          await runner.close();
          await Promise.allSettled([...requests]);
        }
      });
      return closing;
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    const relayRun = relay?.run(stop.signal).catch(() => {});
    try {
      await channel.run(
        (request) => {
          const harness =
            request.op === "prompt" || request.op === "resumeNativeSession"
              ? request.input?.harness
              : request.op === "installSkills"
                ? request.input?.harness
                : request.op === "configureReadableVariables" || request.op === "testModelConnection"
                  ? request.harness
                  : undefined;
          if (harness !== undefined && harness !== config.selectedHarness)
            return Promise.resolve(Response.json({ error: "unselected_runtime_harness" }, { status: 409 }));
          const work = runner.handleDialout(request, stop.signal);
          requests.add(work);
          void work.then(
            () => requests.delete(work),
            () => requests.delete(work),
          );
          return work;
        },
        stop.signal,
        closeNative,
      );
    } finally {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      await closeNative();
      await relayRun;
      // Keep WAL available until pending native completion/auth callbacks drain.
      // SQLite closes naturally when this listener-free process exits.
    }
  } else {
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: config.port,
      fetch: (request) => runner.handle(request),
      maxRequestBodySize: 1048576,
    });
    const shutdown = () => {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      void Promise.allSettled([server.stop(true), closeBroker(), runner.close()]);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
}
if (process.argv[2] === "github-client") {
  process.exitCode = await runGitHubClient(process.argv.slice(3));
} else
  void (
    process.argv[2] === "github-install"
      ? runGitHubInstallMode()
      : process.argv[2] === "install-artifact"
        ? runArtifactInstallMode()
        : process.argv[2] === "install-harness"
          ? runHarnessInstallMode()
          : main(process.argv[2] === "dialout")
  ).catch(async (error: unknown) => {
    await closeGitHubBroker?.().catch(() => {
      process.stderr.write("github_socket_cleanup_failed\n");
    });
    startupReason = runtimeStartupFailure(error, startupReason);
    await reportRuntimeFailure?.(error).catch(() => {});
    process.stderr.write("runner_boot_failed\n");
    process.exitCode = 1;
  });
