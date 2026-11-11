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
  delay,
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForLaunch,
  waitReady,
} from "./golden.ts";
import { GOLDEN_ROOT, GoldenError, initCommand, pullCommand, type ShellCommand } from "./golden-config.ts";
import { type HelperNegotiation, negotiateHelper } from "./helper.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import { type MachineSize, resolveMachineSize } from "./machine-size.ts";
import { type ModelChoice, resolveModelChoice } from "./models.ts";
import { isNonMutatingProviderRefusal, type Provider } from "./provider.ts";
import { resolveRepositoryDir } from "./repository-context.ts";
import type { SandboxRecord, SandboxStore } from "./sandbox.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS, SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { assertProviderOf, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";
import { installSkill, validateSkillPins } from "./skillpack.ts";

/** Four hours: long enough for an autonomous run, short enough that a forgotten sandbox stops by itself. */
export const DEFAULT_LAUNCH_TTL_SECONDS = 14_400;

/** The longest TTL any provider accepts (boat's 30 days). Each provider's own limit is in `PROVIDER_LIMITS`. */
export const MAX_LAUNCH_TTL_SECONDS = Math.max(...Object.values(PROVIDER_LIMITS).map((limits) => limits.maxTtlSeconds));

const OUTPUT_LIMIT = 2000;
const OWNERSHIP_RETRY_DELAY_MS = 1000;

export interface LaunchRequest {
  /** Explicit admission requirement; slice 0 supports diagnose only. */
  helperCapabilities?: string[];
  skills?: string[];
  credentialId?: string;
  size?: MachineSize;
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
  /** Owner-authorized legacy GitHub repair, private transport; no model credential required. */
  refreshGitHub?(actor: GoldenActor, provider: Provider, sandboxId: string): Promise<{ login: string }>;

  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId?: string,
    credentialVersion?: number,
  ): Promise<HarnessCredentials>;
  /** Server-owned native credential admission, before provider allocation/hydration. */
  admit?(actor: GoldenActor, credentials: HarnessCredentials, sandboxId: string): Promise<void>;
  hydrateNative?(
    actor: GoldenActor,
    credentials: HarnessCredentials,
    sandboxId: string,
    provider: Provider,
    providerSandboxId: string,
  ): Promise<boolean>;
  releaseUnallocated?(actor: GoldenActor, credentials: HarnessCredentials, sandboxId: string): Promise<void>;
  /** Validate the pinned native owner without rehydrating imported auth state. */
  assertTurn?(actor: GoldenActor, sandboxId: string, resuming: boolean): Promise<void>;
  /** Returns true when native output needs the shared lifecycle admission lease. */
  assertExec?(actor: GoldenActor, sandboxId: string): Promise<boolean | void>;
  nativeSecrets?(
    actor: GoldenActor,
    sandboxId: string,
    provider: Provider,
    providerSandboxId: string,
    phase?: "before" | "after",
  ): Promise<string[]>;
}

export interface LaunchStores {
  goldens: GoldenStore;
  sandboxes: SandboxStore;
  credentials: LaunchCredentialResolver;
  connections?: {
    /** Renew already-authorized gateway leases after a physical deadline change. */
    renewLifetime?(provider: Provider, sandboxId: string): Promise<void>;
    defaults?(actor: GoldenActor, visibility: "private" | "org"): Promise<string[]>;
    validate(actor: GoldenActor, ids: string[], visibility: "private" | "org"): Promise<void>;
    bind(sandboxId: string, ids: string[]): Promise<void>;
    /** After init, before any first prompt (including an idle launch). */
    prepare?(provider: Provider, sandbox: SandboxRecord, actor: GoldenActor): Promise<void>;
  };
}

/** What a launch did about GitHub. A launch without a connection still succeeds, and says so here. */
export interface GitHubLaunchInfo {
  /** Advertised expiry of the injected token, not a guarantee against owner rotation. */
  tokenExpiresAt?: string;
  status: GitHubStatus;
  /** The account git and gh act as in the sandbox. */
  login?: string;
  /** Why GitHub is not set up, or what to fix. Never holds a token. */
  message?: string;
}

export interface LaunchResult {
  helper: HelperNegotiation;
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
  /** Trusted server policy: extra physical Modal seconds reserved for extension. */
  extensionHeadroomSeconds?: number;
  /** Trusted server telemetry only; never request input or a raw-error sink. */
  onInitialization?: (stage: LaunchInitializationStage) => void;
  /** Trusted pre-dispatch fence; failure is provably before provider allocation. */
  beforeFork?: (sandboxId: string) => Promise<void>;
  /** Confirmed registration handoff; errors use the recorded initialization cleanup. */
  onRegistered?: (sandbox: SandboxRecord) => Promise<void>;
  /** Trusted server-only narrowing for managed orchestrator parents. Not a public launch field. */
  privateParent?: true;
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
  try {
    validateSkillPins(request.skills ?? []);
  } catch {
    throw new LaunchError(
      "invalid_request",
      "Skills require distinct public org/slug@exact-version pins (maximum 20).",
    );
  }
  if (request.skills?.length && !stores.sandboxes.recordSkills)
    throw new LaunchError("invalid_request", "Skill receipts are not supported by this store.");
  const harness = checkHarness(provider, request.harness);
  const prompt = checkPrompt(request.prompt);
  const choice = checkModel(provider, harness, request);

  const golden = await goldenForLaunch(stores.goldens, actor, request.golden, request.provider);
  const helper = negotiateHelper(golden.helperReceipt, golden.providerSnapshotId);
  const requestedHelper = request.helperCapabilities;
  if (
    requestedHelper !== undefined &&
    (!Array.isArray(requestedHelper) ||
      requestedHelper.length > 8 ||
      requestedHelper.some((cap) => typeof cap !== "string" || cap.length > 64))
  )
    throw new LaunchError("invalid_request", "Invalid helper capabilities.");
  if (requestedHelper?.some((cap) => helper.status !== "supported" || !helper.capabilities.includes(cap as "diagnose")))
    throw new LaunchError(
      "unsupported",
      "Helper capability unsupported. Rebuild the golden with armada golden update; this server supports diagnose only.",
      {
        helperRefusal:
          helper.status === "unsupported"
            ? helper
            : { reason: "helper_capability_unsupported", action: "rebuild_golden" },
      },
    );
  // The provider comes from the golden. The one the caller passed must be that backend, never another.
  assertProviderOf(provider, golden.provider);
  const checkedTtl = checkTtl(golden.provider, request.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS);
  const ttlSeconds = options.privateParent
    ? checkedTtl
    : Math.min(checkedTtl, PROVIDER_LIMITS[golden.provider].maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS);
  const extensionHeadroom = options.extensionHeadroomSeconds ?? DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS;
  if (
    !Number.isSafeInteger(extensionHeadroom) ||
    extensionHeadroom < 0 ||
    extensionHeadroom > PROVIDER_LIMITS.modal.maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS
  )
    throw new LaunchError("invalid_request", "Invalid server sandbox extension headroom policy.");
  if (golden.visibility === "private" && golden.ownerId !== actor.userId) {
    throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
  }
  const repositoryDir = resolveRepositoryDir(golden, request.repo);
  const resourceProject = golden.config.repos.find((repo) => repo.dir === repositoryDir);
  const machineSize = resolveMachineSize(golden.provider, request.size, repositoryDir, golden.sizePolicy);
  const prepareNativeCwd = provider.prepareNativeHarnessCwd?.bind(provider);
  if (repositoryDir !== null && !prepareNativeCwd)
    throw new LaunchError("invalid_request", `${provider.id} cannot prepare a native repository working directory.`);
  // Public launch visibility cannot change access or source authority. Only the
  // trusted managed-parent caller may narrow sandbox access; the source stays unchanged.
  const visibility = options.privateParent ? "private" : golden.visibility;
  const connectionIds = [
    ...new Set(request.connections ?? (await stores.connections?.defaults?.(actor, visibility)) ?? []),
  ];
  if (connectionIds.length && !stores.connections)
    throw new LaunchError("invalid_request", "MCP launch connections are not configured.");
  await stores.connections?.validate(actor, connectionIds, visibility);
  const snapshot = golden.providerSnapshotId;
  if (!snapshot) throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  const credentials = await stores.credentials.resolve(actor, harness, request.credentialId);
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
  let noAllocation = true;
  let failed = false;
  try {
    await stores.credentials.admit?.(actor, credentials, id);
    await options.beforeFork?.(id);
    noAllocation = false;
    const forked = await provider
      .fork({
        from: snapshot,
        ...(machineSize.effective ? { size: machineSize.effective } : {}),
        noEnv: true,
        env,
        // Managed parents own their separate lifecycle policy. Ordinary workers need stop headroom.
        ttlSeconds: options.privateParent
          ? ttlSeconds
          : golden.provider === "modal"
            ? Math.min(
                PROVIDER_LIMITS.modal.maxTtlSeconds,
                ttlSeconds + SANDBOX_STOP_MARGIN_SECONDS + extensionHeadroom,
              )
            : Math.min(PROVIDER_LIMITS.boat.maxTtlSeconds, ttlSeconds + SANDBOX_STOP_MARGIN_SECONDS),
        labels: {
          armada: "sandbox",
          sandbox: id,
          org: actor.orgId,
          owner: actor.userId,
          golden: golden.name,
          visibility,
          harness,
          ...(credentials.binding
            ? {
                credentialId: credentials.binding.credentialId,
                credentialVersion: String(credentials.binding.credentialVersion),
              }
            : {}),
        },
      })
      .catch((error) => {
        noAllocation = isNonMutatingProviderRefusal(error);
        if (!noAllocation)
          throw new LaunchError(
            "outcome_unknown",
            "The provider fork outcome is unknown. Check sandbox status before retrying.",
            { cause: error },
          );
        throw error;
      });

    const activityLeaseId = stores.sandboxes.activityOwnership ? crypto.randomUUID() : undefined;
    let record: SandboxRecord;
    try {
      record = await stores.sandboxes.insert({
        ...credentials.binding,
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
        machineSize,
        ...(resourceProject
          ? {
              resourceProject: {
                version: 1 as const,
                url: resourceProject.url,
                branch: resourceProject.branch,
                dir: resourceProject.dir,
              },
            }
          : {}),
        ...(request.ttlSeconds === undefined ? {} : { requestedTtlSeconds: request.ttlSeconds }),
        effectiveTtlSeconds: ttlSeconds,
        ...(!options.privateParent && forked.expiresAt
          ? {
              expiresAt: new Date(
                Math.min(
                  Date.now() + ttlSeconds * 1000,
                  forked.expiresAt.getTime() - SANDBOX_STOP_MARGIN_SECONDS * 1000,
                ),
              ).toISOString(),
            }
          : {}),
        model: choice.model,
        reasoningEffort: choice.reasoningEffort,
        visibility,
      });
      childRecorded = true;
    } catch (error) {
      await quietly(() => provider.delete({ sandboxId: forked.id }));
      throw error;
    }

    const progress = (stage: LaunchInitializationStage) => {
      try {
        void Promise.resolve(options.onInitialization?.(stage)).catch(() => {});
      } catch {
        /* Best effort only. */
      }
    };
    const start = async (signal: AbortSignal) => {
      if ((record.visibility ?? golden.visibility) !== visibility) {
        await provider.delete({ sandboxId: forked.id });
        throw new LaunchError(
          "start_failed",
          "The sandbox store did not persist the requested independent visibility; no agent was started.",
          { safeReason: "visibility_not_persisted" },
        );
      }
      progress("initialization_bind");
      await stores.connections?.bind(record.id, connectionIds);
      progress("initialization_ready");
      const ready = await waitReady(provider, forked.id, options);
      progress("initialization_hydrate");
      if (
        credentials.codexAuthJson &&
        !(await stores.credentials.hydrateNative?.(actor, credentials, id, provider, ready.id))
      )
        await writeCodexAuth(provider, ready.id, secrets);
      progress("initialization_github");
      const launchGithub: GitHubLaunchInfo =
        github.status === "connected"
          ? await setupGitHub(provider, ready.id, github.identity, secrets)
          : { status: github.status, message: github.message };
      if (github.status === "connected" && github.expiresAt)
        launchGithub.tokenExpiresAt = github.expiresAt.toISOString();
      await setup(provider, ready.id, record.id, golden, secrets, progress, options.sleep);
      progress("initialization_cwd");
      if (repositoryDir !== null && prepareNativeCwd)
        await prepareNativeCwd({ sandboxId: ready.id, harness, cwd: `${GOLDEN_ROOT}/${repositoryDir}` });
      if (request.skills?.length) {
        const receipts = [];
        for (const skill of request.skills)
          receipts.push(
            await installSkill(
              provider,
              ready.id,
              repositoryDir === null ? GOLDEN_ROOT : `${GOLDEN_ROOT}/${repositoryDir}`,
              harness,
              skill,
              golden.buildWarnings,
            ),
          );
        if (repositoryDir !== null) {
          // Local Git metadata only: do not stage third-party launch skills with worker changes.
          const paths = [
            "/.companion/skills.lock.json",
            "/.companion/skills.lock.json.lock",
            ...request.skills.flatMap((skill) => {
              const slug = skill.split("@")[0]!.split("/")[1];
              return [`/.agents/skills/${slug}/`, ...(harness === "claude" ? [`/.claude/skills/${slug}/`] : [])];
            }),
          ];
          const excluded = await provider.exec({
            sandboxId: ready.id,
            cwd: `${GOLDEN_ROOT}/${repositoryDir}`,
            timeoutSeconds: 30,
            command: `exclude=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$exclude")" && printf '\\n%s\\n' ${paths.map((path) => `'${path}'`).join(" ")} >> "$exclude"`,
          });
          if (excluded.detached || excluded.timedOut || excluded.truncated || excluded.exitCode !== 0)
            throw new Error("Skillpack checkout exclusions could not be prepared.");
        }
        await stores.sandboxes.recordSkills!(record.id, receipts);
        record.skills = receipts;
      }
      progress("initialization_mcp");
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now())
        throw new LaunchError("invalid_request", "Provider lifetime has no remaining preservation headroom.");
      await stores.connections?.prepare?.(provider, record, actor);
      progress("initialization_publish");
      if (prompt === undefined) {
        signal.throwIfAborted();
        return {
          patch: { status: "ready" as const },
          result: finish(
            record,
            golden,
            launchGithub,
            ttlSeconds,
            record.expiresAt ? new Date(record.expiresAt) : (ready.expiresAt ?? forked.expiresAt),
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
      try {
        await stores.sandboxes.recordTurnModel?.(record.id, receipt.promptId, choice.model);
      } catch {
        try {
          console.error("armada: turn model request record unavailable; accepted prompt continues.");
        } catch {
          /* Logging must not change accepted work. */
        }
      }
      return {
        patch: {
          status: "running" as const,
          conversationIds: [receipt.conversationId],
          taskPromptId: receipt.promptId,
        },
        result: finish(
          record,
          golden,
          launchGithub,
          ttlSeconds,
          record.expiresAt ? new Date(record.expiresAt) : (ready.expiresAt ?? forked.expiresAt),
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
      await options.onRegistered?.(record);
      if (activityLeaseId)
        return await sandboxActivity(stores.sandboxes, record, {}, start, {
          initialLeaseId: activityLeaseId,
          // Preserve each sequential pull/init command's existing timeout, plus bounded
          // physical readiness, native preparation, credential setup and prompt overhead.
          deadlineMs:
            15 * 60_000 +
            (request.skills?.length ?? 0) * 300_000 +
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
    if (noAllocation)
      await stores.credentials.releaseUnallocated?.(actor, credentials, id).catch((error) => {
        if (!failed) throw error;
      });
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
    helper: negotiateHelper(golden.helperReceipt, golden.providerSnapshotId),
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
  armadaSandboxId: string,
  golden: GoldenRecord,
  secrets: readonly string[],
  progress: (stage: LaunchInitializationStage) => void,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<void> {
  for (const repo of golden.config.repos) {
    progress("initialization_repository");
    await run(provider, sandboxId, pullCommand(repo), `git pull of ${repo.dir}`, secrets, {
      dir: repo.dir,
      sandboxId: armadaSandboxId,
      sleep,
    });
  }
  for (const [index, command] of golden.config.init.entries()) {
    progress("initialization_commands");
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
  if (result.detached)
    throw new LaunchError("start_failed", "GitHub setup started in the background.", {
      safeReason: "github_setup_background",
    });
  if (result.timedOut || result.exitCode !== 0) {
    throw new LaunchError(
      "start_failed",
      `GitHub could not be set up in the sandbox.${output(result.stderr, result.stdout, secrets)}`,
      { safeReason: result.timedOut ? "github_setup_timeout" : "github_setup_nonzero" },
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
    throw new LaunchError("start_failed", redact("Codex auth.json could not be written in the sandbox.", secrets), {
      safeReason: "native_auth_write_failed",
    });
  }
}

async function run(
  provider: Provider,
  sandboxId: string,
  spec: ShellCommand,
  label: string,
  secrets: readonly string[],
  repository?: { dir: string; sandboxId: string; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  const request = {
    sandboxId,
    command: spec.command,
    cwd: spec.cwd,
    timeoutSeconds: spec.timeoutSeconds,
  };
  let result = await provider.exec(request);
  // Production has shown intermittent refusals with either selector path. Retry only
  // a completed Git ownership rejection once; keep the same user and ownership guard.
  if (
    repository !== undefined &&
    !result.detached &&
    !result.timedOut &&
    result.exitCode === 128 &&
    result.stderr.includes("detected dubious ownership in repository")
  ) {
    await repository.sleep(OWNERSHIP_RETRY_DELAY_MS);
    let retry: "ownership_refused" | "exit_nonzero" | "timed_out" | "detached" | "exec_threw" | "succeeded" =
      "exec_threw";
    try {
      result = await provider.exec(request);
      if (result.detached) retry = "detached";
      else if (result.timedOut) retry = "timed_out";
      else if (result.exitCode === 0) retry = "succeeded";
      else if (result.exitCode === 128 && result.stderr.includes("detected dubious ownership in repository"))
        retry = "ownership_refused";
      else retry = "exit_nonzero";
    } finally {
      try {
        console.info(
          JSON.stringify({
            event: "launch_repository_ownership_retry",
            sandboxId: repository.sandboxId,
            provider: provider.id,
            providerSandboxId: sandboxId,
            attempt: 2,
            delayMs: OWNERSHIP_RETRY_DELAY_MS,
            outcome: retry === "succeeded" ? "recovered" : "failed",
            retry,
          }),
        );
      } catch {
        // Best-effort diagnostics must not change launch or cleanup outcomes.
      }
    }
  }
  if (result.detached) throw new LaunchError("init_failed", `${label} started in the background.`);
  if (result.timedOut) {
    throw new LaunchError("init_failed", `${label} timed out.${output(result.stderr, result.stdout, secrets)}`);
  }
  if (result.exitCode !== 0) {
    const failure = new LaunchError(
      "init_failed",
      `${label} failed (exit ${result.exitCode}).${output(result.stderr, result.stdout, secrets)}`,
    );
    // Inspect stderr before diagnostic-tail truncation; never bypass Git's ownership guard.
    if (repository !== undefined && result.stderr.includes("detected dubious ownership in repository"))
      throw new LaunchError(
        "init_failed",
        `Cannot update repository '${repository.dir}' in sandbox ${repository.sandboxId}: checkout ownership does not match the user running sandbox commands. Report this golden and sandbox ID to its administrator to check command-user and checkout UIDs before retrying.`,
        { cause: failure, safeReason: "repository_ownership_mismatch" },
      );
    throw failure;
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
      : new LaunchError(error.code, error.message, {
          cause: error.cause,
          sandboxId,
          ...(error.safeReason ? { safeReason: error.safeReason } : {}),
        });
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
