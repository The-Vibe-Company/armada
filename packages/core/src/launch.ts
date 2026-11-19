import { LAUNCH_CREDENTIAL_BINDING_GUIDANCE } from "./api-failure.ts";
import { CLAUDE_ENDPOINT_ENV } from "./claude-endpoint.ts";
import { CODEX_ENDPOINT_ENV } from "./codex-endpoint.ts";
import { HARNESSES, type Harness } from "./contract.ts";
import { type HarnessCredentials, redact } from "./credentials.ts";
import { GITHUB_NOT_CONNECTED, type GitHubAccess, type GitHubStatus, githubEnv } from "./github.ts";
import {
  type GoldenActor,
  type GoldenLimits,
  type GoldenRecord,
  type GoldenStore,
  goldenForLaunch,
  waitReady,
} from "./golden.ts";
import { GoldenError, type GoldenRepo, initCommand, pullCommand } from "./golden-config.ts";
import { HARNESS_CAPABILITIES } from "./harnesses.ts";
import { type HelperNegotiation, negotiateHelper } from "./helper.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import { nativeLaunch } from "./launch-native.ts";
import { goldenLaunchPlacements } from "./launch-placement.ts";
import {
  applyLaunchAccountDefaults,
  prepareLaunchPlan,
  resolveLaunchConnections,
  resolveLaunchSkills,
} from "./launch-plan.ts";
import { runtimeLaunch } from "./launch-runtime.ts";
import { LaunchSecretRefusal, RuntimeLaunchSecretRefusal } from "./launch-secrets.ts";
import type { LaunchStage } from "./launch-stages.ts";
import { isLaunchTtlSeconds, validateLaunchSkillPins } from "./launch-validation.ts";
import { type MachineSize, resolveMachineSize } from "./machine-size.ts";
import { type ModelChoice, resolveModelChoice } from "./models.ts";
import { OPENCODE_CONNECTION_PROVIDER, OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "./opencode-endpoint.ts";
import { PrivateSkillError } from "./private-skill-error.ts";
import { type Provider, ProviderError } from "./provider.ts";
import { resolveRepositoryDir } from "./repository-context.ts";
import { isExternalRef, type SandboxRecord, type SandboxStore } from "./sandbox.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS, SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { OUTPUT_DIRECTORY } from "./sandbox-output-limits.ts";
import * as placement from "./sandbox-provider.ts";
import { assertProviderOf, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";
import { VaultError } from "./vault-error.ts";

export { prepareLaunchWorkspace } from "./launch-workspace.ts";

/** Four hours: long enough for an autonomous run, short enough that a forgotten sandbox stops by itself. */
export const DEFAULT_LAUNCH_TTL_SECONDS = 14_400;

/** The longest TTL any provider accepts (boat's 30 days). Each provider's own limit is in `PROVIDER_LIMITS`. */
export const MAX_LAUNCH_TTL_SECONDS = Math.max(...Object.values(PROVIDER_LIMITS).map((limits) => limits.maxTtlSeconds));

export interface LaunchRequest {
  /** Explicit admission requirement; slice 0 supports diagnose only. */
  helperCapabilities?: string[];
  skills?: string[];
  /** Ignore environment, org and personal defaults, not explicit/template pins. */
  skipSkillDefaults?: boolean;
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
  /** Opaque caller reference stored on the sandbox (#2568). Refused before any allocation when malformed. */
  externalRef?: string;
  stopWhenWorkMerged?: boolean;
}

/** Resolves what the sandbox receives. `armada launch` builds it from `resolveCredentials`. */
export interface LaunchCredentialResolver {
  defaults?(
    actor: GoldenActor,
    harness: Harness,
  ): Promise<{ credentialId: string | null; model: string | null } | undefined>;
  /** Resolve only for private launch pins, under the already-authorized actor. Never harness env. */
  skillpackKey?(actor: GoldenActor): Promise<string | null>;
  /** Server transport port; the browser-safe launcher must not import SSH implementation. */
  installPrivateSkill?(
    provider: Provider,
    input: Parameters<typeof import("./private-skill.ts").installPrivateSkill>[1],
  ): ReturnType<typeof import("./private-skill.ts").installPrivateSkill>;
  /** Owner-authorized legacy GitHub repair, private transport; no model credential required. */
  refreshGitHub?(actor: GoldenActor, provider: Provider, sandboxId: string): Promise<{ login: string }>;

  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId?: string,
    credentialVersion?: number,
  ): Promise<HarnessCredentials>;
  /** Read-only caller repository authorization before provider allocation. */
  authorizeRepositories?(
    actor: GoldenActor,
    credentials: Pick<HarnessCredentials, "github">,
    repos: readonly GoldenRepo[],
  ): Promise<void>;
  /** Server-owned native credential admission, before provider allocation/hydration. */
  enrollAccount?(actor: GoldenActor, credentials: HarnessCredentials): Promise<void>;
  releaseAdmission?(sandboxId: string): Promise<void>;
  admit?(actor: GoldenActor, credentials: HarnessCredentials, sandboxId: string, model?: string): Promise<void>;
  hydrateNative?(
    actor: GoldenActor,
    credentials: HarnessCredentials,
    sandboxId: string,
    provider: Provider,
    providerSandboxId: string,
  ): Promise<boolean>;
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
  skillDefaults?: {
    resolve(
      actor: GoldenActor,
      golden: GoldenRecord,
    ): Promise<{ environment: string[]; org: string[]; personal: string[] }>;
  };
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
    prepare?(provider: Provider, sandbox: SandboxRecord, actor: GoldenActor, signal?: AbortSignal): Promise<void>;
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
  /** Only after the selected Armada runtime acknowledged initialization/admission. */
  runtime?: { kind: "armada"; epoch: string };
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
  /** Trusted deployment-wide default, never a client launch option. Boat only. */
  boatRuntimeDefault?: {
    policy: NonNullable<LaunchOptions["boatRuntime"]>;
    provider(actor: GoldenActor, golden: GoldenRecord): Promise<Provider>;
    credentials: LaunchCredentialResolver;
    connections: NonNullable<LaunchStores["connections"]>;
  };
  /** Custom endpoints require private runtime configuration even when ordinary Boat launches stay native. */
  boatEndpointRuntime?: NonNullable<LaunchOptions["boatRuntimeDefault"]>;
  /** Coordinator-owned Modal cutover default; never selected by request JSON. */
  modalRuntimeDefault?: NonNullable<LaunchOptions["boatRuntimeDefault"]>;
  /** Frozen template account version, not a public launch override. */
  credentialVersion?: number;

  /** Trusted per-launch opt-in for common-runtime routes; private bootstrap, never a native-agent fallback. */
  runtime?: LaunchOptions["boatRuntime"];
  boatRuntime?: {
    start(input: {
      host: Provider;
      actor: GoldenActor;
      sandbox: SandboxRecord;
      credentials: HarnessCredentials;
      signal: AbortSignal;
      /** Private resume policy: validate configuration before activating compute. */
      activate?: (signal: AbortSignal) => Promise<void>;
      restoreCheckpoint?: { epoch: string; watermark: number; conversationId: string | null };
    }): Promise<{
      prompt: Provider["prompt"];
      epoch: string;
      prepareWorkspace?: (
        golden: GoldenRecord,
        progress: (stage: LaunchInitializationStage) => void,
        sleep?: (ms: number) => Promise<void>,
      ) => Promise<GitHubLaunchInfo>;
      installSkills?: (
        references: string[],
        key: string | null,
      ) => Promise<import("./delegated-access.ts").SkillReceipt[]>;
    }>;
  };
  /** Trusted server policy: extra physical Modal seconds reserved for extension. */
  extensionHeadroomSeconds?: number;
  /** Trusted server telemetry only; never request input or a raw-error sink. */
  onInitialization?: (stage: LaunchInitializationStage) => void;
  /** Trusted pre-dispatch fence; failure is provably before provider allocation. */
  beforeFork?: (sandboxId: string) => Promise<void>;
  /** Confirmed registration handoff; errors use the recorded initialization cleanup. */
  onRegistered?: (sandbox: SandboxRecord) => Promise<void>;
  /** Trusted final-start admission/bootstrap, after all repository and init work. */
  beforeStart?: (provider: Provider, sandbox: SandboxRecord) => Promise<void>;
  /** Trusted server-only narrowing for private sandbox parents. Not a public launch field. */
  privateParent?: true;
  /** Trusted narrowing for ordinary sandboxes with owner-scoped access. Keeps normal TTL policy. */
  privateVisibility?: true;
  /** For tests. */
  newId?: () => string;
}

export interface LaunchPlan {
  acceptedAt: number;
  provider: Provider;
  stores: LaunchStores;
  request: LaunchRequest;
  options: LaunchOptions;
  golden: GoldenRecord;
  runtime: LaunchOptions["runtime"];
  harness: Harness;
  prompt: string | undefined;
  choice: ModelChoice;
  ttlSeconds: number;
  allocationTtlSeconds: number;
  repositoryDir: string | null;
  resourceProject: GoldenRepo | undefined;
  machineSize: ReturnType<typeof resolveMachineSize>;
  prepareNativeCwd: Provider["prepareNativeHarnessCwd"];
  visibility: "private" | "org";
  connectionIds: string[];
  snapshot: string;
  credentials: HarnessCredentials;
  github: GitHubAccess;
  connected: Extract<GitHubAccess, { status: "connected" }> | null;
  env: HarnessCredentials["env"];
  secrets: HarnessCredentials["secrets"];
}

/** The shared golden launcher owns these sequential intervals from admission to harness readiness. */
function modalLaunchTiming(startedAt: number) {
  const stages: { stage: string; ms: number }[] = [];
  let previous = startedAt;
  let enabled = false;
  return {
    mark(stage: string, at?: number) {
      if (stage === "launch_plan") enabled = true;
      if (!enabled) return;
      const now = at ?? performance.now();
      stages.push({ stage, ms: now - previous });
      previous = now;
    },
    report(sandboxId: string, path: "native" | "enrolled") {
      if (!enabled) return;
      try {
        console.error(
          JSON.stringify({ event: "modal_launch_timing", sandboxId, path, totalMs: previous - startedAt, stages }),
        );
      } catch {
        // Timing must not change the launch outcome.
      }
    },
  };
}

function validateGoldenLaunch(request: LaunchRequest) {
  // The sandbox row (and so the stage table) exists only after the fork (#2560).
  const acceptedAt = performance.now();
  validateLaunchSkillPins(request.skills ?? []);
  if (request.skipSkillDefaults !== undefined && typeof request.skipSkillDefaults !== "boolean")
    throw new LaunchError("invalid_request", "skipSkillDefaults must be a boolean.");
  if (request.stopWhenWorkMerged !== undefined && typeof request.stopWhenWorkMerged !== "boolean")
    throw new LaunchError("invalid_request", "stopWhenWorkMerged must be a boolean.");
  if (request.externalRef !== undefined && !isExternalRef(request.externalRef))
    throw new LaunchError("invalid_request", "externalRef must be 1 to 200 characters without control characters.");
  return { request, acceptedAt };
}

async function resolveGoldenLaunch(
  provider: Provider,
  stores: LaunchStores,
  actor: GoldenActor,
  validated: ReturnType<typeof validateGoldenLaunch>,
  options: LaunchOptions,
  timing: ReturnType<typeof modalLaunchTiming>,
): Promise<LaunchPlan> {
  let { request } = validated;
  const { acceptedAt } = validated;
  const golden = await goldenForLaunch(stores.goldens, actor, request.golden, request.provider);
  if (golden.visibility === "private" && golden.ownerId !== actor.userId)
    throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
  const launchPlacement = goldenLaunchPlacements[golden.provider];
  const defaultRuntime =
    !options.runtime && !options.boatRuntime ? launchPlacement.runtimeDefault(options, request.harness) : undefined;
  if (defaultRuntime) {
    provider = await defaultRuntime.provider(actor, golden);
    if (provider.id !== golden.provider)
      throw new LaunchError("invalid_request", "Runtime default must retain the golden provider; no native fallback.");
    stores = { ...stores, credentials: defaultRuntime.credentials, connections: defaultRuntime.connections };
    options = { ...options, runtime: defaultRuntime.policy };
  }
  const runtime = options.runtime ?? options.boatRuntime;
  const harness = checkHarness(provider, request.harness, Boolean(runtime));
  if (
    runtime &&
    (!["boat", "modal"].includes(provider.id) ||
      (harness !== "codex" && harness !== "claude" && harness !== "opencode") ||
      options.privateParent ||
      options.privateVisibility)
  )
    throw new LaunchError(
      "invalid_request",
      "The experimental runtime supports ordinary Boat or Modal Codex/Claude/OpenCode workers only.",
    );
  const prompt = checkPrompt(request.prompt);
  request = applyLaunchAccountDefaults(request, await stores.credentials.defaults?.(actor, harness));
  const choice = checkModel(provider, harness, request, Boolean(runtime));

  request = {
    ...request,
    skills: await resolveLaunchSkills(
      request,
      () => stores.skillDefaults?.resolve(actor, golden),
      () => new LaunchError("invalid_request", "Merged skills exceed 20 distinct exact pins."),
    ),
  };
  if (request.skills?.length && !stores.sandboxes.recordSkills)
    throw new LaunchError("invalid_request", "Skill receipts are not supported by this store.");

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
  const repositoryDir = resolveRepositoryDir(golden, request.repo);
  const resourceProject = golden.config.repos.find((repo) => repo.dir === repositoryDir);
  const machineSize = resolveMachineSize(golden.provider, request.size, repositoryDir, golden.sizePolicy);
  const prepareNativeCwd = provider.prepareNativeHarnessCwd?.bind(provider);
  if (repositoryDir !== null && !prepareNativeCwd && !runtime)
    throw new LaunchError("invalid_request", `${provider.id} cannot prepare a native repository working directory.`);
  // Public launch visibility cannot change access or source authority. Only the
  // trusted managed-parent caller may narrow sandbox access; the source stays unchanged.
  const visibility = options.privateParent || options.privateVisibility ? "private" : golden.visibility;
  const connectionIds = await resolveLaunchConnections(
    request.connections,
    () => stores.connections?.defaults?.(actor, visibility),
    async (ids) => {
      if (runtime && request.helperCapabilities?.length)
        throw new LaunchError("invalid_request", "The experimental runtime does not yet support helpers.");
      if (ids.length && !stores.connections)
        throw new LaunchError("invalid_request", "MCP launch connections are not configured.");
      await stores.connections?.validate(actor, ids, visibility);
    },
  );
  const snapshot = golden.providerSnapshotId;
  if (!snapshot) throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  if (golden.provider === "modal") timing.mark("launch_plan");
  const credentials = await stores.credentials.resolve(actor, harness, request.credentialId, options.credentialVersion);
  if (golden.provider === "modal") timing.mark("credential_resolution");
  if (runtime && !credentials.binding)
    throw new VaultError("credential_binding_required", LAUNCH_CREDENTIAL_BINDING_GUIDANCE);
  if (credentials.morphModels) {
    const models = credentials.morphModels;
    const prefix = `${OPENCODE_CONNECTION_PROVIDER}/`;
    let selected = request.model ?? models[0]!;
    if (harness === "opencode" && request.model?.startsWith(prefix)) {
      const upstream = request.model.slice(prefix.length);
      if (models.includes(upstream)) selected = upstream;
    }
    if (!models.includes(selected))
      throw new LaunchError("invalid_request", "Choose a Morph plan model configured on this account.");
    choice.model = harness === "opencode" ? `${prefix}${selected}` : selected;
  }
  const endpointRuntime = launchPlacement.endpointRuntime?.(options);
  if (!runtime && (credentials.env[CLAUDE_ENDPOINT_ENV] || credentials.env[CODEX_ENDPOINT_ENV]) && endpointRuntime) {
    // Re-enter through the shared runtime selection before allocating compute.
    // Its resolver excludes native GitHub/model environment delivery.
    return resolveGoldenLaunch(
      provider,
      stores,
      actor,
      validateGoldenLaunch(request),
      {
        ...options,
        boatRuntimeDefault: endpointRuntime,
      },
      timing,
    );
  }
  const customEndpoint =
    (credentials.env[CLAUDE_ENDPOINT_ENV] && "Claude gateways") ||
    (credentials.env[CODEX_ENDPOINT_ENV] && "Codex endpoints");
  if (customEndpoint && !placement.launchInfrastructure(provider.id).nativeRuntime && !runtime)
    throw new LaunchError(
      "invalid_request",
      `Custom ${customEndpoint} require the Boat runtime artifacts; use --provider modal or a Docker host.`,
    );
  if (harness === "opencode") {
    if (!placement.launchInfrastructure(provider.id).nativeRuntime && !runtime)
      throw new LaunchError("invalid_request", "OpenCode on Boat requires the shared runtime.");
    const configured = credentials.env[OPENCODE_ENDPOINT_ENV];
    if (configured) {
      const endpoint = parseOpenCodeEndpoint(JSON.parse(configured));
      // Shared accounts advertise provider model IDs; native OpenCode needs its connection namespace.
      if (!credentials.morphModels && endpoint.models.includes(choice.model))
        choice.model = `${OPENCODE_CONNECTION_PROVIDER}/${choice.model}`;
      const wanted = choice.model;
      if (!endpoint.models.some((id) => wanted === `${OPENCODE_CONNECTION_PROVIDER}/${id}`))
        throw new LaunchError(
          "invalid_request",
          `Choose an ${OPENCODE_CONNECTION_PROVIDER}/<model> configured on the OpenCode connection.`,
        );
    } else if (!choice.model.startsWith("opencode/") && !choice.model.startsWith("opencode-go/")) {
      throw new LaunchError(
        "invalid_request",
        "An OpenCode key requires an explicit opencode/<model> or opencode-go/<model> selection.",
      );
    }
  }
  const github: GitHubAccess = credentials.github ?? { status: "not_connected", message: GITHUB_NOT_CONNECTED };
  const connected = github.status === "connected" ? github : null;
  const env = connected ? { ...credentials.env, ...githubEnv(connected.token) } : credentials.env;
  const secrets = connected ? [...credentials.secrets, connected.token] : credentials.secrets;

  await stores.credentials.authorizeRepositories?.(actor, credentials, golden.config.repos);
  return {
    acceptedAt,
    provider,
    stores,
    request,
    options,
    golden,
    runtime,
    harness,
    prompt,
    choice,
    ttlSeconds,
    // Managed parents own their separate lifecycle policy. Ordinary workers need stop headroom.
    allocationTtlSeconds: launchPlacement.allocationTtlSeconds(
      ttlSeconds,
      extensionHeadroom,
      options.privateParent === true,
    ),
    repositoryDir,
    resourceProject,
    machineSize,
    prepareNativeCwd,
    visibility,
    connectionIds,
    snapshot,
    credentials,
    github,
    connected,
    env,
    secrets,
  };
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
  initialProvider: Provider,
  initialStores: LaunchStores,
  actor: GoldenActor,
  initialRequest: LaunchRequest,
  initialOptions: LaunchOptions = {},
): Promise<LaunchResult> {
  const validated = validateGoldenLaunch(initialRequest);
  const timing = modalLaunchTiming(validated.acceptedAt);
  const launch = await prepareLaunchPlan(
    () => validated,
    (validated) => resolveGoldenLaunch(initialProvider, initialStores, actor, validated, initialOptions, timing),
    (plan) => goldenLaunchPlacements[plan.golden.provider],
  );
  const plan = launch.resolved;
  const {
    acceptedAt,
    provider,
    stores,
    request,
    options,
    golden,
    harness,
    prompt,
    choice,
    ttlSeconds,
    repositoryDir,
    resourceProject,
    machineSize,
    visibility,
    connectionIds,
    credentials,
    secrets,
  } = plan;
  const strategy = plan.runtime ? runtimeLaunch(plan.runtime) : nativeLaunch;
  const id = (options.newId ?? (() => crypto.randomUUID()))();
  const releaseOperation = await stores.goldens.beginOperation?.(golden.id, {
    kind: "launch",
    snapshotId: golden.providerSnapshotId,
    sandboxId: golden.providerSandboxId,
  });
  let childRecorded = false;
  let noAllocation = true;
  try {
    const forked = await launch.admit({
      actor,
      id,
      forkEnv: () => strategy.forkEnv(plan),
      beforeAllocation: () => timing.mark("preallocation_admission"),
      allocationRisk: (risk) => {
        noAllocation = !risk;
      },
    });

    const claimedAt = performance.now();
    timing.mark("provider_allocation", claimedAt);
    const activityLeaseId = stores.sandboxes.activityOwnership ? crypto.randomUUID() : undefined;
    let record: SandboxRecord;
    try {
      record = await stores.sandboxes.insert({
        ...credentials.binding,
        ...strategy.recordFields(plan),
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
        ...(request.stopWhenWorkMerged === undefined ? {} : { stopWhenWorkMerged: request.stopWhenWorkMerged }),
        ...(request.externalRef === undefined ? {} : { externalRef: request.externalRef }),
      });
      childRecorded = true;
    } catch (error) {
      await quietly(async () => {
        if (await deleteNeverStartedSandbox(provider, forked.id)) noAllocation = true;
      });
      throw error;
    }

    // Launch-time measurement (#2560) must never change the launch it measures.
    const mark = async (stage: LaunchStage, elapsedMs = 0) => {
      try {
        await stores.sandboxes.recordLaunchStage?.(record.id, stage, elapsedMs);
      } catch {
        /* Best effort only. */
      }
    };
    // Both past stages are aged from one instant: reading the clock again after the first await would let a slow
    // store call make `accepted` look younger than `provider_claimed` when the fork returns at once.
    const recordedAt = performance.now();
    await mark("accepted", recordedAt - acceptedAt);
    await mark("provider_claimed", recordedAt - claimedAt);
    const progress = (stage: LaunchInitializationStage) => {
      try {
        void Promise.resolve(options.onInitialization?.(stage)).catch(() => {});
      } catch {
        /* Best effort only. */
      }
    };
    const start = async (signal: AbortSignal) => {
      if ((record.boatRuntime === true || record.runtimeTransport === "dialout") !== (strategy.kind === "enrolled"))
        throw new LaunchError("start_failed", "The sandbox runtime selection was not persisted; no agent was started.");
      if ((record.visibility ?? golden.visibility) !== visibility) {
        await provider.delete({ sandboxId: forked.id });
        throw new LaunchError(
          "start_failed",
          "The sandbox store did not persist the requested independent visibility; no agent was started.",
          { safeReason: "visibility_not_persisted" },
        );
      }
      if (
        (placement.launchInfrastructure(golden.provider).nativeRuntime || strategy.kind === "enrolled") &&
        credentials.usagePricing
      )
        await stores.sandboxes.recordUsagePricingContext?.(record.id, credentials.usagePricing);
      progress("initialization_bind");
      await stores.connections?.bind(record.id, connectionIds);
      progress("initialization_ready");
      timing.mark("registration_and_binding");
      const ready = await waitReady(provider, forked.id, options);
      await mark("machine_started");
      timing.mark("machine_readiness");
      const {
        github: launchGithub,
        prompt: dispatchPrompt,
        runtime: provenance,
      } = await strategy
        .initialize(plan, {
          actor,
          launchId: id,
          record,
          providerSandboxId: ready.id,
          signal,
          progress,
          runtimeStarted: () => timing.mark("runtime_startup"),
          mark: async (stage) => {
            await mark(stage);
            if (stage === "checkout_done") timing.mark("workspace_preparation");
          },
          reportGitHub: (launchGithub) => {
            try {
              console.error(
                JSON.stringify({
                  event: "launch_github_prepared",
                  sandboxId: record.id,
                  goldenId: golden.id,
                  provider: provider.id,
                  path: strategy.kind,
                  status: launchGithub.status,
                  repositorySelected: repositoryDir !== null,
                  configuredRepositories: golden.config.repos.length,
                }),
              );
            } catch {
              // Safe diagnostics must not change launch outcomes. Never include tokens or helper contents.
            }
          },
        })
        .catch((error: unknown) => {
          if (strategy.kind === "enrolled" && error instanceof LaunchSecretRefusal)
            throw new RuntimeLaunchSecretRefusal(error, record.id);
          throw error;
        });
      timing.mark("finish_initialization");
      progress("initialization_publish");
      // Every harness and path is ready for a prompt here; a launch prompt's dispatch is not launch time.
      await mark("harness_ready");
      timing.mark("ready_stage_record");
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
            provenance,
          ),
        };
      }
      const promptRequest = {
        sandboxId: ready.id,
        harness,
        text: `${prompt}\n\nSave any deliverable files directly in ${OUTPUT_DIRECTORY}. Create that directory if needed.`,
        signal,
        ...choice,
      };
      const receipt = await dispatchPrompt(promptRequest).catch((error: unknown) => {
        throw new LaunchError("prompt_failed", `The agent could not be started: ${redact(messageOf(error), secrets)}`, {
          cause: error,
        });
      });
      try {
        await stores.sandboxes.recordTurnModel?.(
          record.id,
          receipt.promptId,
          choice.model,
          credentials.usagePricing ?? null,
        );
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
          provenance,
        ),
      };
    };
    const reportTiming = (result: LaunchResult) => {
      timing.report(record.id, strategy.kind);
      return result;
    };
    try {
      await options.onRegistered?.(record);
      if (activityLeaseId)
        return reportTiming(
          await sandboxActivity(stores.sandboxes, record, {}, start, {
            initialLeaseId: activityLeaseId,
            // Preserve each sequential pull/init command's existing timeout, plus bounded
            // physical readiness, native preparation, credential setup and prompt overhead.
            deadlineMs:
              15 * 60_000 +
              (request.skills?.length ?? 0) * 300_000 +
              1000 *
                (golden.config.repos.reduce((sum, repo) => sum + pullCommand(repo).timeoutSeconds, 0) +
                  golden.config.init.reduce((sum, command) => sum + initCommand(command).timeoutSeconds, 0)),
            failurePatch: (error) => ({
              status: "failed",
              statusReason: withSandbox(error, record.id, secrets).message,
            }),
          }),
        );
      // Caller-role legacy stores cannot mutate server coordination columns. Keep their
      // original RLS-only flow; the deployed server always uses the owned scoped store.
      const completed = await start(new AbortController().signal);
      await stores.sandboxes.update(record.id, completed.patch);
      return reportTiming(completed.result);
    } catch (error) {
      const failure = withSandbox(error, record.id, secrets);
      if (!activityLeaseId)
        await quietly(() => stores.sandboxes.update(record.id, { status: "failed", statusReason: failure.message }));
      await quietly(() => provider.stop({ sandboxId: forked.id }));
      throw failure;
    }
  } finally {
    // Coordination cleanup must not replace accepted work or the original launch error.
    // DELETE is idempotent; retry once after a transient failure. Published lifecycle
    // state also reconciles reservations through release_account_agent_reservation.
    try {
      await stores.credentials.releaseAdmission?.(id);
    } catch {
      try {
        await stores.credentials.releaseAdmission?.(id);
      } catch {
        // Never log exception text: database/provider errors may contain credentials.
        await quietly(async () =>
          console.warn("Launch admission cleanup failed; reservation reconciliation is required."),
        );
      }
    }
    // An unrecorded physical outcome remains owned by this durable fence.
    if (childRecorded || noAllocation) {
      try {
        await releaseOperation?.();
      } catch {
        await quietly(async () => console.warn("Launch operation cleanup failed; fence reconciliation is required."));
      }
    }
  }
}

/** Confirm absence once, without treating an accepted asynchronous deletion as completion. */
export async function deleteNeverStartedSandbox(provider: Provider, sandboxId: string): Promise<boolean> {
  try {
    const receipt = await provider.delete({ sandboxId });
    if (receipt.status === "deleted") return true;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "not_found") return true;
    throw error;
  }
  try {
    await provider.get(sandboxId);
    return false;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "not_found") return true;
    return false;
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
  runtime?: LaunchResult["runtime"],
): LaunchResult {
  return {
    helper: negotiateHelper(golden.helperReceipt, golden.providerSnapshotId),
    sandbox: { ...record, status, conversationIds },
    golden,
    github,
    ttlSeconds,
    ...(expiresAt ? { expiresAt } : {}),
    ...(prompt ?? {}),
    ...(runtime ? { runtime } : {}),
  };
}

function withSandbox(error: unknown, sandboxId: string, secrets: readonly string[]): LaunchError {
  if (error instanceof PrivateSkillError)
    return new LaunchError(
      "start_failed",
      `Private Skillpack installation failed at ${error.stage}: ${error.reason}.`,
      {
        cause: error,
        sandboxId,
        skillFailure: { reason: error.reason, stage: error.stage },
      },
    );
  if (error instanceof LaunchError) {
    return error.sandboxId === sandboxId
      ? error
      : new LaunchError(error.code, error.message, {
          cause: error.cause,
          sandboxId,
          ...(error.safeReason ? { safeReason: error.safeReason } : {}),
          ...(error.skillFailure ? { skillFailure: error.skillFailure } : {}),
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

function checkHarness(provider: Provider, harness: string, runtime = false): Harness {
  if (placement.launchInfrastructure(provider.id).nativeCli && harness === "opencode" && !runtime)
    throw new LaunchError(
      "invalid_request",
      "OpenCode on Boat requires the Boat runtime artifacts to be installed on the server.",
    );
  if (
    !(HARNESSES as readonly string[]).includes(harness) ||
    (!(provider.harnesses as readonly string[]).includes(harness) &&
      !(runtime && placement.launchInfrastructure(provider.id).nativeCli && harness === "opencode"))
  ) {
    throw new LaunchError(
      "invalid_request",
      `Unknown agent '${harness}'. Use one of: ${provider.harnesses.join(", ")}.`,
    );
  }
  return harness as Harness;
}

/** Before anything is allocated: an unknown model or effort is refused, never replaced by another. */
function checkModel(provider: Provider, harness: Harness, request: LaunchRequest, runtime = false): ModelChoice {
  const choice = resolveModelChoice(harness, request);
  if (!(runtime ? HARNESS_CAPABILITIES[harness] : provider.capabilities[harness])?.reasoningEffort) {
    throw new LaunchError("invalid_request", `${provider.id} cannot set a reasoning effort for ${harness}.`);
  }
  return choice;
}

/** Refused when the golden's provider cannot keep a machine that long: never clamped. */
function checkTtl(provider: SandboxProviderId, ttlSeconds: number): number {
  const limits = PROVIDER_LIMITS[provider];
  if (!isLaunchTtlSeconds(provider, ttlSeconds)) {
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
