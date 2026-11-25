import { LAUNCH_CREDENTIAL_BINDING_GUIDANCE } from "./api-failure.ts";
import type { Harness } from "./contract.ts";
import type { HarnessCredentials } from "./credentials.ts";
import type { GitHubStatus } from "./github.ts";
import { type GoldenActor, type GoldenLimits, type GoldenRecord, type GoldenStore, goldenForLaunch } from "./golden.ts";
import { GoldenError, type GoldenRepo } from "./golden-config.ts";
import { HARNESSES, isHarness, runtimeHarnessSupported } from "./harnesses.ts";
import { type HelperNegotiation, negotiateHelper } from "./helper.ts";
import { LaunchError, type LaunchInitializationStage } from "./launch-error.ts";
import { applyLaunchAccountDefaults, resolveLaunchConnections, resolveLaunchSkills } from "./launch-plan.ts";
import { isLaunchTtlSeconds, validateLaunchSkillPins } from "./launch-validation.ts";
import { capabilities } from "./machine-capabilities.ts";
import { type MachineSize, resolveMachineSize } from "./machine-size.ts";
import { resolveModelChoice } from "./models.ts";
import { OPENCODE_CONNECTION_PROVIDER, OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "./opencode-endpoint.ts";
import type { PromptReceipt, PromptRequest, Provider } from "./provider.ts";
import { resolveRepositoryDir } from "./repository-context.ts";
import { isExternalRef, type SandboxRecord, type SandboxStore } from "./sandbox.ts";
import { DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS, SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { assertProviderOf, HOST_CAPABILITIES, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";
import { VaultError } from "./vault-error.ts";

export const DEFAULT_LAUNCH_TTL_SECONDS = 14_400;

export interface LaunchRequest {
  helperCapabilities?: string[];
  skills?: string[];

  skipSkillDefaults?: boolean;
  credentialId?: string;
  size?: MachineSize;

  golden: string;
  visibility?: "private" | "org";
  connections?: string[];

  provider?: SandboxProviderId;
  harness: Harness;

  prompt?: string;

  repo?: string;
  ttlSeconds?: number;

  model?: string;

  reasoningEffort?: string;

  externalRef?: string;
  stopWhenWorkMerged?: boolean;
}

export interface LaunchCredentialResolver {
  defaults?(
    actor: GoldenActor,
    harness: Harness,
  ): Promise<{ credentialId: string | null; model: string | null } | undefined>;

  skillpackKey?(actor: GoldenActor): Promise<string | null>;

  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId?: string,
    credentialVersion?: number,
  ): Promise<HarnessCredentials>;

  authorizeRepositories?(
    actor: GoldenActor,
    credentials: Pick<HarnessCredentials, "github">,
    repos: readonly GoldenRepo[],
  ): Promise<void>;

  enrollAccount?(actor: GoldenActor, credentials: HarnessCredentials): Promise<void>;
  releaseAdmission?(sandboxId: string): Promise<void>;
  admit?(actor: GoldenActor, credentials: HarnessCredentials, sandboxId: string, model?: string): Promise<void>;

  assertTurn?(actor: GoldenActor, sandboxId: string, resuming: boolean): Promise<void>;
}

export interface LaunchStores {
  skillDefaults?: {
    resolve(
      actor: GoldenActor,
      golden: GoldenRecord,
    ): Promise<{ environment: string[]; org: string[]; personal: string[] }>;
  };
  goldens: GoldenStore;
  sandboxes: Pick<SandboxStore, "recordSkills">;
  credentials: LaunchCredentialResolver;
  connections?: {
    renewLifetime?(provider: Provider, sandboxId: string): Promise<void>;
    defaults?(actor: GoldenActor, visibility: "private" | "org"): Promise<string[]>;
    validate(actor: GoldenActor, ids: string[], visibility: "private" | "org"): Promise<void>;
    bind(sandboxId: string, ids: string[]): Promise<void>;

    prepare?(provider: Provider, sandbox: SandboxRecord, actor: GoldenActor, signal?: AbortSignal): Promise<void>;
  };
}

export interface GitHubLaunchInfo {
  tokenExpiresAt?: string;
  status: GitHubStatus;

  login?: string;

  message?: string;
}

export interface LaunchResult {
  runtime?: { kind: "armada"; epoch: string };
  helper: HelperNegotiation;
  sandbox: SandboxRecord;
  golden: GoldenRecord;
  github: GitHubLaunchInfo;
  ttlSeconds: number;

  expiresAt?: Date;

  conversationId?: string;
  promptId?: string;
}

export interface LaunchOptions extends GoldenLimits {
  boatRuntimeDefault?: {
    policy: NonNullable<LaunchOptions["boatRuntime"]>;
    provider(actor: GoldenActor, golden: GoldenRecord): Promise<Provider>;
    credentials: LaunchCredentialResolver;
    connections: NonNullable<LaunchStores["connections"]>;
  };

  modalRuntimeDefault?: NonNullable<LaunchOptions["boatRuntimeDefault"]>;

  credentialVersion?: number;

  runtime?: LaunchOptions["boatRuntime"];
  boatRuntime?: {
    supportsScopedAccess?: true;
    start(input: {
      host: Provider;
      actor: GoldenActor;
      sandbox: SandboxRecord;
      credentials: HarnessCredentials;
      signal: AbortSignal;
      onEnrolled?: (epoch: string) => void;

      activate?: (signal: AbortSignal) => Promise<void>;
      restoreCheckpoint?: { epoch: string; watermark: number; conversationId: string | null };
    }): Promise<{
      prompt: (request: PromptRequest) => Promise<PromptReceipt>;
      epoch: string;
      prepareWorkspace?: (
        golden: GoldenRecord,
        progress: (stage: LaunchInitializationStage) => void,
        sleep?: (ms: number) => Promise<void>,
      ) => Promise<GitHubLaunchInfo>;
      installScopedReference?: Provider["exec"];
      installSkills?: (
        references: string[],
        key: string | null,
      ) => Promise<import("./delegated-access.ts").SkillReceipt[]>;
    }>;
  };

  extensionHeadroomSeconds?: number;

  privateVisibility?: true;
}

export function requireRuntimeHarness(provider: SandboxProviderId, harness: Harness) {
  if (!runtimeHarnessSupported(provider, harness))
    throw new LaunchError(
      "invalid_request",
      `Unknown agent '${harness}'. Use one of: ${HARNESSES.filter((id) => runtimeHarnessSupported(provider, id)).join(", ")}.`,
    );
}

function validateGoldenLaunchRequest(request: LaunchRequest) {
  validateLaunchSkillPins(request.skills ?? []);
  if (request.skipSkillDefaults !== undefined && typeof request.skipSkillDefaults !== "boolean")
    throw new LaunchError("invalid_request", "skipSkillDefaults must be a boolean.");
  if (request.stopWhenWorkMerged !== undefined && typeof request.stopWhenWorkMerged !== "boolean")
    throw new LaunchError("invalid_request", "stopWhenWorkMerged must be a boolean.");
  if (request.externalRef !== undefined && !isExternalRef(request.externalRef))
    throw new LaunchError("invalid_request", "externalRef must be 1 to 200 characters without control characters.");
}

export async function prepareGoldenLaunch(
  provider: Provider,
  stores: LaunchStores,
  actor: GoldenActor,
  request: LaunchRequest,
  options: LaunchOptions = {},
) {
  validateGoldenLaunchRequest(request);
  const golden = await goldenForLaunch(stores.goldens, actor, request.golden, request.provider);
  if (golden.visibility === "private" && golden.ownerId !== actor.userId)
    throw new GoldenError("not_found", `No golden named '${golden.name}'.`);
  requireRuntimeHarness(golden.provider, request.harness);
  const harness = checkHarness(provider, request.harness);
  const prompt = validateGoldenLaunchPrompt(request.prompt);
  request = applyLaunchAccountDefaults(request, await stores.credentials.defaults?.(actor, harness));
  const choice = resolveModelChoice(harness, request);

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

  validateGoldenLaunchHelpers(golden, request.helperCapabilities);

  assertProviderOf(provider, golden.provider);
  const { ttlSeconds, allocationTtlSeconds, repositoryDir, machineSize } = resolveGoldenLaunchResources(
    golden,
    request,
    options,
  );
  const resourceProject = golden.config.repos.find((repo) => repo.dir === repositoryDir);

  const visibility = options.privateVisibility ? "private" : golden.visibility;
  await resolveLaunchConnections(
    request.connections,
    () => stores.connections?.defaults?.(actor, visibility),
    async (ids) => {
      if (request.helperCapabilities?.length)
        throw new LaunchError("invalid_request", "The experimental runtime does not yet support helpers.");
      if (ids.length && !stores.connections)
        throw new LaunchError("invalid_request", "MCP launch connections are not configured.");
      await stores.connections?.validate(actor, ids, visibility);
    },
  );
  const snapshot = golden.providerSnapshotId;
  if (!snapshot) throw new GoldenError("conflict", `Golden '${golden.name}' has no snapshot yet.`);
  const credentials = await stores.credentials.resolve(actor, harness, request.credentialId, options.credentialVersion);
  if (!credentials.binding) throw new VaultError("credential_binding_required", LAUNCH_CREDENTIAL_BINDING_GUIDANCE);
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
  if (harness === "opencode") {
    const configured = credentials.env[OPENCODE_ENDPOINT_ENV];
    if (configured) {
      const endpoint = parseOpenCodeEndpoint(JSON.parse(configured));

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
  await stores.credentials.authorizeRepositories?.(actor, credentials, golden.config.repos);
  return {
    request,
    golden,
    harness,
    prompt,
    choice,
    ttlSeconds,
    allocationTtlSeconds,
    repositoryDir,
    resourceProject,
    machineSize,
    visibility,
    snapshot,
    credentials,
  };
}

function checkHarness(provider: Provider, harness: string) {
  if (
    !isHarness(harness) ||
    (!(provider.harnesses as readonly string[]).includes(harness) &&
      !(provider.id === "boat" && harness === "opencode"))
  ) {
    throw new LaunchError(
      "invalid_request",
      `Unknown agent '${harness}'. Use one of: ${provider.harnesses.join(", ")}.`,
    );
  }
  return harness;
}

function validateGoldenLaunchHelpers(golden: GoldenRecord, requestedHelper: string[] | undefined) {
  const helper = negotiateHelper(golden.helperReceipt, golden.providerSnapshotId);
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
      "Helper capability unsupported. Rebuild the golden with armada snapshot update; this server supports diagnose only.",
      {
        helperRefusal:
          helper.status === "unsupported"
            ? helper
            : { reason: "helper_capability_unsupported", action: "rebuild_golden" },
      },
    );
}

function resolveGoldenLaunchResources(
  golden: GoldenRecord,
  request: Pick<LaunchRequest, "ttlSeconds" | "repo" | "size">,
  options: Pick<LaunchOptions, "extensionHeadroomSeconds">,
) {
  const checkedTtl = checkTtl(golden.provider, request.ttlSeconds ?? DEFAULT_LAUNCH_TTL_SECONDS);
  const ttlSeconds = Math.min(checkedTtl, capabilities(golden.provider).maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS);
  const extensionHeadroom = options.extensionHeadroomSeconds ?? DEFAULT_SANDBOX_EXTENSION_HEADROOM_SECONDS;
  if (
    !Number.isSafeInteger(extensionHeadroom) ||
    extensionHeadroom < 0 ||
    extensionHeadroom > PROVIDER_LIMITS.modal.maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS
  )
    throw new LaunchError("invalid_request", "Invalid server sandbox extension headroom policy.");
  const repositoryDir = resolveRepositoryDir(golden, request.repo);
  const machineSize = resolveMachineSize(golden.provider, request.size, repositoryDir, golden.sizePolicy);
  return {
    ttlSeconds,
    allocationTtlSeconds: Math.min(
      capabilities(golden.provider).maxTtlSeconds,
      ttlSeconds +
        SANDBOX_STOP_MARGIN_SECONDS +
        (HOST_CAPABILITIES[golden.provider].reserveExtensionHeadroom ? extensionHeadroom : 0),
    ),
    repositoryDir,
    machineSize,
  };
}

function checkTtl(provider: SandboxProviderId, ttlSeconds: number) {
  const limits = PROVIDER_LIMITS[provider];
  if (!isLaunchTtlSeconds(provider, ttlSeconds)) {
    throw new LaunchError(
      "invalid_request",
      `The TTL must be a whole number of seconds from 1 to ${limits.maxTtlSeconds} (${limits.maxTtlLabel} on ${provider}).`,
    );
  }
  return ttlSeconds;
}

function validateGoldenLaunchPrompt(prompt: string | undefined) {
  if (prompt === undefined) return undefined;
  if (prompt.trim() === "") {
    throw new LaunchError("invalid_request", "The prompt is empty. Leave it out to launch an idle sandbox.");
  }
  return prompt;
}
