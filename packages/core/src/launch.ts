import { HARNESSES, type Harness } from "./contract.ts";
import { CODEX_AUTH_ENV, type HarnessCredentials, redact } from "./credentials.ts";
import {
  GH_MISSING_NOTE,
  GH_PRESENT_MARKER,
  GITHUB_NOT_CONNECTED,
  type GitHubAccess,
  type GitHubStatus,
  type GitIdentity,
  githubEnv,
  gitSetupCommand,
} from "./github.ts";
import {
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForLaunch,
  waitReady,
} from "./golden.ts";
import { GOLDEN_ROOT, GoldenError, initCommand, pullCommand, type ShellCommand } from "./golden-config.ts";
import { LaunchError } from "./launch-error.ts";
import { type ModelChoice, resolveModelChoice } from "./models.ts";
import { isNonMutatingProviderRefusal, type Provider } from "./provider.ts";
import { resolveRepositoryDir } from "./repository-context.ts";
import type { SandboxRecord, SandboxStore } from "./sandbox.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { assertProviderOf, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";

/** Four hours: long enough for an autonomous run, short enough that a forgotten sandbox stops by itself. */
export const DEFAULT_LAUNCH_TTL_SECONDS = 14_400;

/** The longest TTL any provider accepts (boat's 30 days). Each provider's own limit is in `PROVIDER_LIMITS`. */
export const MAX_LAUNCH_TTL_SECONDS = Math.max(...Object.values(PROVIDER_LIMITS).map((limits) => limits.maxTtlSeconds));

const OUTPUT_LIMIT = 2000;

export interface LaunchRequest {
  /** The golden's human name. Resolved under the caller's own visibility, never by a provider id. */
  golden: string;
  visibility?: "private" | "org";
  connections?: string[];
  /** Needed only when the name exists on several providers. Never a substitute for the golden's own. */
  provider?: SandboxProviderId;
  harness: Harness;
  /** With a prompt the agent starts at once. Without one the sandbox is left ready for the first `send`. */
  prompt?: string;
  /** Configured dir or owner/repo; resolved and persisted as a native harness cwd. */
  repo?: string;
  ttlSeconds?: number;
  /** A model of `MODEL_CATALOG` for this harness. Default: the harness's default model. */
  model?: string;
  /** An effort the model accepts. Default: the harness's default effort. */
  reasoningEffort?: string;
}

/** Resolves what the sandbox receives. `armada launch` builds it from `resolveCredentials`. */
export interface LaunchCredentialResolver {
  resolve(actor: GoldenActor, harness: Harness): Promise<HarnessCredentials>;
}

export interface LaunchStores {
  goldens: GoldenStore;
  sandboxes: SandboxStore;
  credentials: LaunchCredentialResolver;
  connections?: {
    defaults?(actor: GoldenActor, visibility: "private" | "org"): Promise<string[]>;
    validate(actor: GoldenActor, ids: string[], visibility: "private" | "org"): Promise<void>;
    bind(sandboxId: string, ids: string[]): Promise<void>;
    /** After init, before any first prompt (including an idle launch). */
    prepare?(provider: Provider, sandbox: SandboxRecord, actor: GoldenActor): Promise<void>;
  };
}

/** What a launch did about GitHub. A launch without a connection still succeeds, and says so here. */
export interface GitHubLaunchInfo {
  status: GitHubStatus;
  /** The account git and gh act as in the sandbox. */
  login?: string;
  /** Why GitHub is not set up, or what to fix. Never holds a token. */
  message?: string;
}

export interface LaunchResult {
  sandbox: SandboxRecord;
  golden: GoldenRecord;
  github: GitHubLaunchInfo;
  ttlSeconds: number;
  /** When the provider stops the sandbox by itself. */
  expiresAt?: Date;
  /** Set when a prompt was sent. */
  conversationId?: string;
  promptId?: string;
}

export interface LaunchOptions extends GoldenLimits {
  /** For tests. */
  newId?: () => string;
}

/**
 * Forks a golden into a sandbox, brings its repos up to date, runs its init commands and, with a
 * prompt, starts the agent.
 *
 * The caller's own database role does the reads and writes: a private golden of someone else is
 * `not_found`. The fork starts from the stored snapshot name, gets `noEnv` and an environment with
 * only the credentials of this harness (user over org), and never writes them to the golden. A fork
 * inherits neither TTL nor labels, so both are set here. When anything fails after the fork the
 * sandbox is recorded as `failed` and its machine is stopped.
 */
export async function launchSandbox(
  provider: Provider,
  stores: LaunchStores,
  actor: GoldenActor,
  request: LaunchRequest,
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  const harness = checkHarness(provider, request.harness);
  const prompt = checkPrompt(request.prompt);
  const choice = checkModel(provider, harness, request);

  const golden = await goldenForLaunch(stores.goldens, actor, request.golden, request.provider);
  // The provider comes from the golden. The one the caller passed must be that backend, never another.
  assertProviderOf(provider, golden.provider);
  const ttlSeconds = checkTtl(golden.provider, request.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS);
  if (golden.visibility === "private" && golden.ownerId !== actor.userId) {
    throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
  }
  const repositoryDir = resolveRepositoryDir(golden, request.repo);
  const prepareNativeCwd = provider.prepareNativeHarnessCwd?.bind(provider);
  if (repositoryDir !== null && !prepareNativeCwd)
    throw new LaunchError("invalid_request", `${provider.id} cannot prepare a native repository working directory.`);
  const visibility = request.visibility ?? golden.visibility;
  if (golden.visibility === "private" && visibility === "org")
    throw new LaunchError("invalid_request", "A private golden cannot launch an org sandbox.");
  const connectionIds = [
    ...new Set(request.connections ?? (await stores.connections?.defaults?.(actor, visibility)) ?? []),
  ];
  if (connectionIds.length && !stores.connections)
    throw new LaunchError("invalid_request", "MCP launch connections are not configured.");
  await stores.connections?.validate(actor, connectionIds, visibility);
  const snapshot = golden.providerSnapshotId;
  if (!snapshot) throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  const credentials = await stores.credentials.resolve(actor, harness);
  const github: GitHubAccess = credentials.github ?? { status: "not_connected", message: GITHUB_NOT_CONNECTED };
  const connected = github.status === "connected" ? github : null;
  const env = connected ? { ...credentials.env, ...githubEnv(connected.token) } : credentials.env;
  const secrets = connected ? [...credentials.secrets, connected.token] : credentials.secrets;

  const id = (options.newId ?? (() => crypto.randomUUID()))();
  const releaseOperation = await stores.goldens.beginOperation?.(golden.id, {
    kind: "launch",
    snapshotId: golden.providerSnapshotId,
    sandboxId: golden.providerSandboxId,
  });
  let childRecorded = false;
  let noAllocation = false;
  let failed = false;
  try {
    const forked = await provider
      .fork({
        from: snapshot,
        noEnv: true,
        env,
        ttlSeconds,
        labels: {
          armada: "sandbox",
          sandbox: id,
          org: actor.orgId,
          owner: actor.userId,
          golden: golden.name,
          visibility,
          harness,
        },
      })
      .catch((error) => {
        noAllocation = isNonMutatingProviderRefusal(error);
        throw error;
      });

    const activityLeaseId = stores.sandboxes.activityOwnership ? crypto.randomUUID() : undefined;
    let record: SandboxRecord;
    try {
      record = await stores.sandboxes.insert({
        id,
        provider: golden.provider,
        providerSandboxId: forked.id,
        goldenId: golden.id,
        orgId: golden.orgId,
        ownerId: actor.userId,
        harness,
        status: "starting",
        ...(activityLeaseId ? { activityLeaseId } : {}),
        repositoryDir,
        ...(request.ttlSeconds === undefined ? {} : { requestedTtlSeconds: request.ttlSeconds }),
        effectiveTtlSeconds: ttlSeconds,
        model: choice.model,
        reasoningEffort: choice.reasoningEffort,
        visibility,
      });
      childRecorded = true;
    } catch (error) {
      await quietly(() => provider.delete({ sandboxId: forked.id }));
      throw error;
    }

    const start = async (signal: AbortSignal) => {
      if ((record.visibility ?? golden.visibility) !== visibility) {
        await provider.delete({ sandboxId: forked.id });
        throw new LaunchError(
          "start_failed",
          "The sandbox store did not persist the requested independent visibility; no agent was started.",
        );
      }
      await stores.connections?.bind(record.id, connectionIds);
      const ready = await waitReady(provider, forked.id, options);
      if (credentials.codexAuthJson) await writeCodexAuth(provider, ready.id, secrets);
      const launchGithub: GitHubLaunchInfo =
        github.status === "connected"
          ? await setupGitHub(provider, ready.id, github.identity, secrets)
          : { status: github.status, message: github.message };
      await setup(provider, ready.id, golden, secrets);
      if (repositoryDir !== null && prepareNativeCwd)
        await prepareNativeCwd({ sandboxId: ready.id, harness, cwd: `${GOLDEN_ROOT}/${repositoryDir}` });
      await stores.connections?.prepare?.(provider, record, actor);
      if (prompt === undefined) {
        signal.throwIfAborted();
        return {
          patch: { status: "ready" as const },
          result: finish(
            record,
            golden,
            launchGithub,
            ttlSeconds,
            ready.expiresAt ?? forked.expiresAt,
            "ready",
            [],
            undefined,
          ),
        };
      }
      const receipt = await provider
        .prompt({ sandboxId: ready.id, harness, text: prompt, signal, ...choice })
        .catch((error: unknown) => {
          throw new LaunchError(
            "prompt_failed",
            `The agent could not be started: ${redact(messageOf(error), secrets)}`,
            {
              cause: error,
            },
          );
        });
      return {
        patch: { status: "running" as const, conversationIds: [receipt.conversationId] },
        result: finish(
          record,
          golden,
          launchGithub,
          ttlSeconds,
          ready.expiresAt ?? forked.expiresAt,
          "running",
          [receipt.conversationId],
          {
            conversationId: receipt.conversationId,
            promptId: receipt.promptId,
          },
        ),
      };
    };
    try {
      if (activityLeaseId)
        return await sandboxActivity(stores.sandboxes, record, {}, start, {
          initialLeaseId: activityLeaseId,
          // Preserve each sequential pull/init command's existing timeout, plus bounded
          // physical readiness, native preparation, credential setup and prompt overhead.
          deadlineMs:
            15 * 60_000 +
            1000 *
              (golden.config.repos.reduce((sum, repo) => sum + pullCommand(repo).timeoutSeconds, 0) +
                golden.config.init.reduce((sum, command) => sum + initCommand(command).timeoutSeconds, 0)),
          failurePatch: (error) => ({ status: "failed", statusReason: withSandbox(error, record.id, secrets).message }),
        });
      // Caller-role legacy stores cannot mutate server coordination columns. Keep their
      // original RLS-only flow; the deployed server always uses the owned scoped store.
      const completed = await start(new AbortController().signal);
      await stores.sandboxes.update(record.id, completed.patch);
      return completed.result;
    } catch (error) {
      const failure = withSandbox(error, record.id, secrets);
      if (!activityLeaseId)
        await quietly(() => stores.sandboxes.update(record.id, { status: "failed", statusReason: failure.message }));
      await quietly(() => provider.stop({ sandboxId: forked.id }));
      throw failure;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // An unrecorded physical outcome remains owned by this durable fence.
    if (childRecorded || noAllocation) {
      await releaseOperation?.().catch((error) => {
        // Preserve an original provider/publication failure if release also loses transport.
        if (!failed) throw error;
      });
    }
  }
}

function finish(
  record: SandboxRecord,
  golden: GoldenRecord,
  github: GitHubLaunchInfo,
  ttlSeconds: number,
  expiresAt: Date | undefined,
  status: SandboxRecord["status"],
  conversationIds: string[],
  prompt: { conversationId: string; promptId: string } | undefined,
): LaunchResult {
  return {
    sandbox: { ...record, status, conversationIds },
    golden,
    github,
    ttlSeconds,
    ...(expiresAt ? { expiresAt } : {}),
    ...(prompt ?? {}),
  };
}

async function setup(
  provider: Provider,
  sandboxId: string,
  golden: GoldenRecord,
  secrets: readonly string[],
): Promise<void> {
  for (const repo of golden.config.repos) {
    await run(provider, sandboxId, pullCommand(repo), `git pull of ${repo.dir}`, secrets);
  }
  for (const [index, command] of golden.config.init.entries()) {
    await run(provider, sandboxId, initCommand(command), `init command ${index + 1}`, secrets);
  }
}

/** Identity and the credential helper, before any repo is pulled. A failure here is a broken sandbox, so it fails the launch. */
async function setupGitHub(
  provider: Provider,
  sandboxId: string,
  identity: GitIdentity,
  secrets: readonly string[],
): Promise<GitHubLaunchInfo> {
  const result = await provider.exec({
    sandboxId,
    command: gitSetupCommand(identity),
    cwd: GOLDEN_ROOT,
    timeoutSeconds: 60,
  });
  if (result.detached) throw new LaunchError("start_failed", "GitHub setup started in the background.");
  if (result.timedOut || result.exitCode !== 0) {
    throw new LaunchError(
      "start_failed",
      `GitHub could not be set up in the sandbox.${output(result.stderr, result.stdout, secrets)}`,
    );
  }
  const present = result.stdout.includes(GH_PRESENT_MARKER);
  return { status: "connected", login: identity.login, ...(present ? {} : { message: GH_MISSING_NOTE }) };
}

async function writeCodexAuth(provider: Provider, sandboxId: string, secrets: readonly string[]): Promise<void> {
  const dir = `${GOLDEN_ROOT}/.codex`;
  const command = `umask 077 && mkdir -p ${dir} && printf '%s' "$${CODEX_AUTH_ENV}" > ${dir}/auth.json`;
  const result = await provider.exec({ sandboxId, command, cwd: GOLDEN_ROOT, timeoutSeconds: 60 });
  if (result.detached || result.timedOut || result.exitCode !== 0) {
    throw new LaunchError("start_failed", redact("Codex auth.json could not be written in the sandbox.", secrets));
  }
}

async function run(
  provider: Provider,
  sandboxId: string,
  spec: ShellCommand,
  label: string,
  secrets: readonly string[],
): Promise<void> {
  const result = await provider.exec({
    sandboxId,
    command: spec.command,
    cwd: spec.cwd,
    timeoutSeconds: spec.timeoutSeconds,
  });
  if (result.detached) throw new LaunchError("init_failed", `${label} started in the background.`);
  if (result.timedOut) {
    throw new LaunchError("init_failed", `${label} timed out.${output(result.stderr, result.stdout, secrets)}`);
  }
  if (result.exitCode !== 0) {
    throw new LaunchError(
      "init_failed",
      `${label} failed (exit ${result.exitCode}).${output(result.stderr, result.stdout, secrets)}`,
    );
  }
}

function output(stderr: string, stdout: string, secrets: readonly string[]): string {
  const text = redact([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"), secrets).trim();
  if (text === "") return "";
  const tail = text.length <= OUTPUT_LIMIT ? text : `...${text.slice(-OUTPUT_LIMIT)}`;
  return `\n${tail}`;
}

function withSandbox(error: unknown, sandboxId: string, secrets: readonly string[]): LaunchError {
  if (error instanceof LaunchError) {
    return error.sandboxId === sandboxId
      ? error
      : new LaunchError(error.code, error.message, { cause: error.cause, sandboxId });
  }
  return new LaunchError("start_failed", `The sandbox could not be started: ${redact(messageOf(error), secrets)}`, {
    cause: error,
    sandboxId,
  });
}

async function quietly(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // The launch already failed; the original error is the one to report.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkHarness(provider: Provider, harness: string): Harness {
  if (
    !(HARNESSES as readonly string[]).includes(harness) ||
    !(provider.harnesses as readonly string[]).includes(harness)
  ) {
    throw new LaunchError("invalid_request", `Unknown agent '${harness}'. Use one of: ${HARNESSES.join(", ")}.`);
  }
  return harness as Harness;
}

/** Before anything is allocated: an unknown model or effort is refused, never replaced by another. */
function checkModel(provider: Provider, harness: Harness, request: LaunchRequest): ModelChoice {
  const choice = resolveModelChoice(harness, request);
  if (!provider.capabilities[harness].reasoningEffort) {
    throw new LaunchError("invalid_request", `${provider.id} cannot set a reasoning effort for ${harness}.`);
  }
  return choice;
}

/** Refused when the golden's provider cannot keep a machine that long: never clamped. */
function checkTtl(provider: SandboxProviderId, ttlSeconds: number): number {
  const limits = PROVIDER_LIMITS[provider];
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > limits.maxTtlSeconds) {
    throw new LaunchError(
      "invalid_request",
      `The TTL must be a whole number of seconds from 1 to ${limits.maxTtlSeconds} (${limits.maxTtlLabel} on ${provider}).`,
    );
  }
  return ttlSeconds;
}

function checkPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.trim() === "") {
    throw new LaunchError("invalid_request", "The prompt is empty. Leave it out to launch an idle sandbox.");
  }
  return prompt;
}
