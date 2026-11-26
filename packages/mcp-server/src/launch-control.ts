import { createHash } from "node:crypto";
import { type Harness, launchFailureHelp, type SandboxProviderId, type VaultStore } from "@armada/core";
import {
  controlRouteKey,
  type LaunchInput,
  launch as launchOperation,
  launchOptionsOperation,
  launchTemplateOperation,
  pinnedModalLaunchReceipt,
} from "@armada/core/contract";
import {
  type GoldenActor,
  type GoldenRecord,
  goldenForLaunch,
  goldenForSettings,
  LaunchError,
  type ModelChoice,
  requireRuntimeHarness,
  resolveModelChoice,
  resolveOrg,
  resolveRepositoryDir,
  type TemplateRuntime,
  type TemplateService,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg } from "./control-caller.ts";
import { UUID } from "./control-input.ts";
import type { ScopedData } from "./data.ts";
import { dockerLaunchRequestId } from "./docker-launch-identity.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { readLaunchOptions } from "./launch-options.ts";
import { controlLaunchReceiptPayload, freshBoatAdmission } from "./ordinary-launch-receipts.ts";
import { usesHostLaunch } from "./provider-runtime-admission.ts";
import { type GoldenLaunchTiming, observeGoldenLaunch } from "./request-timing.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { ToolApiError } from "./tool-api.ts";

type LaunchControlOptions = Pick<
  ControlOptions,
  | "data"
  | "providerFor"
  | "providers"
  | "store"
  | "encryptionKey"
  | "sandboxArmadaAccess"
  | "runtimeMcp"
  | "connections"
  | "skillDefaults"
  | "github"
  | "modelAuth"
  | "launch"
  | "admitHostLaunch"
  | "admitModalLaunch"
>;

const runtimeGoldenMismatch = {
  boat: "Runtime v1 requires a Boat golden.",
  modal: "Modal runtime requires a Modal golden.",
} satisfies Record<SandboxProviderId, string>;

type GoldenLaunchRequest = Extract<LaunchInput, { golden: string }>;

export function launchRoute(
  options: LaunchControlOptions,
  caller: Caller,
  body: GoldenLaunchRequest,
  runtimeProvider?: SandboxProviderId,
) {
  return observeGoldenLaunch("rest", (timing) => launchGolden(options, caller, body, runtimeProvider, timing));
}

async function launchGolden(
  options: LaunchControlOptions,
  caller: Caller,
  body: GoldenLaunchRequest,
  runtimeProvider: SandboxProviderId | undefined,
  timing: GoldenLaunchTiming,
) {
  if (!options.data) throw new VaultError("unavailable", "Launching is not configured on this server.");
  const { connections, idempotencyKey, golden: name, repo, harness, credentialId } = body;
  const maxActiveChildren = typeof body.armadaAccess === "object" ? body.armadaAccess.maxActiveChildren : undefined;
  const armadaAccess = body.armadaAccess ? (maxActiveChildren === undefined ? {} : { maxActiveChildren }) : undefined;
  if (armadaAccess && !options.sandboxArmadaAccess)
    throw new VaultError("unavailable", "Sandbox Armada access is not enabled on this server.");
  const data = options.data(caller);
  const { actor, golden } = await launchActor(data, caller, name, body.org, options.store, body.provider);
  requireRuntimeHarness(golden.provider, harness);
  resolveRepositoryDir(golden, repo);
  if (armadaAccess && harness !== "codex")
    throw new VaultError("unavailable", "Sandbox Armada access is unavailable for this provider/harness.");
  if (runtimeProvider && golden.provider !== runtimeProvider)
    throw new VaultError("invalid", runtimeGoldenMismatch[runtimeProvider]);
  const launchRequest: import("@armada/core/server").LaunchRequest = {
    ...(credentialId === undefined ? {} : { credentialId }),
    golden: name,
    ...(body.size === undefined ? {} : { size: body.size }),
    provider: golden.provider,
    ...(repo === undefined ? {} : { repo }),
    ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
    ...(body.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: body.skipSkillDefaults }),
    ...(body.skills === undefined ? {} : { skills: body.skills }),
    ...(body.helperCapabilities === undefined ? {} : { helperCapabilities: body.helperCapabilities }),
    ...(connections === undefined ? {} : { connections }),
    ...modelChoice(harness, body.model ?? undefined, body.reasoningEffort ?? undefined),
    harness,
    ...(body.prompt == null ? {} : { prompt: body.prompt }),
    ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
    ...(body.stopWhenWorkMerged === false ? { stopWhenWorkMerged: false } : {}),
    ...(body.externalRef === undefined ? {} : { externalRef: body.externalRef }),
  };
  const payload = controlLaunchReceiptPayload(body, golden.id, runtimeProvider);
  timing.checkpoint("admission");
  if (!options.admitModalLaunch) throw new VaultError("unavailable", "Golden launch admission is unavailable.");
  return options.admitModalLaunch(
    actor,
    golden,
    { ...data, ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}) },
    launchRequest,
    {
      ...(idempotencyKey === undefined ? {} : { request: { key: idempotencyKey, payload } }),
      ...(armadaAccess ? { armadaAccess } : {}),
    },
  );
}

export async function launchActor(
  data: ScopedData,
  caller: Caller,
  name: string,
  org: string | undefined,
  store: VaultStore,
  provider?: SandboxProviderId,
  forSettings = false,
): Promise<{ actor: GoldenActor; golden: GoldenRecord }> {
  const resolveGolden = (actor: GoldenActor, prefetched?: GoldenRecord[]) => {
    const goldens =
      prefetched === undefined
        ? data.goldens
        : {
            ...data.goldens,
            findByName: (orgId: string, query: string) =>
              orgId === actor.orgId && query === name
                ? Promise.resolve(prefetched)
                : data.goldens.findByName(orgId, query),
          };
    return (forSettings ? goldenForSettings : goldenForLaunch)(goldens, actor, name, provider);
  };
  const selected = org === undefined ? undefined : scopedOrg(caller, org);
  if (selected !== undefined) {
    const ref = selected.trim().toLowerCase();
    const id = UUID.test(ref) ? ref : (await resolveOrg(store, caller.userId, selected)).id;
    const member = caller.orgs.find((item) => item.orgId === id);
    if (!member) throw new VaultError("forbidden", "This token is scoped to another org.");
    const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
    return { actor, golden: await resolveGolden(actor) };
  }
  if (caller.orgs.length === 0) throw new VaultError("not_found", "You are not a member of an org.");
  if (caller.orgs.length === 1) {
    const member = caller.orgs[0]!;
    const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
    return { actor, golden: await resolveGolden(actor) };
  }
  const lookups = await Promise.all(
    caller.orgs.map(async (member) => ({
      member,
      rows: await data.goldens.findByName(member.orgId, name),
    })),
  );
  const holders = lookups.filter((entry) => entry.rows.length > 0);
  if (holders.length > 1) throw new VaultError("invalid", "Name the org for this golden.");
  const chosen = holders[0] ?? lookups[0]!;
  const actor = { userId: caller.userId, orgId: chosen.member.orgId, role: chosen.member.role };
  return { actor, golden: await resolveGolden(actor, chosen.rows) };
}

export function launchTemplate(
  templates: TemplateService,
  caller: Caller,
  input: Record<string, unknown>,
  runtime: TemplateRuntime | undefined,
  surface: "template_rest" | "routine",
) {
  return observeGoldenLaunch(surface, () => templates.command(caller, "launch", input, runtime), "template_execution");
}

/** One launch path for interactive templates and unattended owner-scoped routines. */
export function templateRuntime(options: LaunchControlOptions, caller: Caller) {
  const stores = options.data?.(caller);
  if (!stores) return undefined;
  const launch = options.launch ?? {};
  return {
    stores: {
      goldens: stores.goldens,
      sandboxes: stores.sandboxes,
      credentials: launchCredentials(
        options.store,
        options.encryptionKey,
        options.github ? { ...options.github, store: options.store } : undefined,
        options.modelAuth,
      ),
      ...(options.connections ? { connections: options.connections } : {}),
    },
    ...(options.admitModalLaunch
      ? {
          admitModal: (actor, golden, request, pin) =>
            options.admitModalLaunch!(actor, golden, stores, request, { pin }),
        }
      : {}),
    ...(options.admitHostLaunch
      ? {
          launchDocker: (
            body: Record<string, unknown>,
            admission: Parameters<NonNullable<TemplateRuntime["launchDocker"]>>[1],
          ) => options.admitHostLaunch!(caller, body, admission),
        }
      : {}),
    options: launch,
  } satisfies TemplateRuntime;
}

function modelChoice(
  harness: Harness,
  model: string | undefined,
  reasoningEffort: string | undefined,
): Partial<ModelChoice> {
  try {
    const checked = resolveModelChoice(harness, { model, reasoningEffort });
    return {
      ...(model === undefined ? {} : { model: checked.model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: checked.reasoningEffort }),
    };
  } catch (error) {
    if (error instanceof LaunchError) throw new VaultError("invalid", error.message);
    throw error;
  }
}

const pinnedModalRefusals = new Map([
  ["credential_busy", "conflict"],
  ["credential_binding_required", "credential_binding_required"],
  ["credential_refused", "credential_refused"],
  ["unauthorized", "credential_refused"],
  ["forbidden", "forbidden"],
  ["not_found", "not_found"],
  ["invalid", "invalid"],
  ["invalid_request", "invalid_request"],
  ["no_credentials", "no_credentials"],
  ["unsupported", "unsupported"],
  ["unavailable", "dependency_unavailable"],
  ["payment_required", "payment_required"],
  ["provider_not_configured", "provider_not_configured"],
  ["provider_routing_unavailable", "provider_routing_unavailable"],
  ["rate_limited", "rate_limited"],
  ["conflict", "conflict"],
]);

function pinnedModalFailure(receipt: Record<string, unknown>) {
  const recorded = typeof receipt.failureCode === "string" ? pinnedModalRefusals.get(receipt.failureCode) : undefined;
  const code = receipt.state === "failed" ? (recorded ?? "start_failed") : "outcome_unknown";
  return new ToolApiError(
    code,
    launchFailureHelp(code) ?? "The pinned Modal launch was refused. Check the template and provider settings.",
    typeof receipt.id === "string" ? { sandboxId: receipt.id } : undefined,
  );
}

function configureHostLaunch(options: ControlOptions, request: Request | undefined) {
  if (options.admitHostLaunch && request) options.configureScopedMutationRequest?.(request);
}

async function handleSandboxLaunch({ caller, body, options, request }: ControlRouteContext) {
  if (usesHostLaunch(body.provider)) configureHostLaunch(options, request);
  const { store, encryptionKey } = options;
  const userId = caller.userId;
  const parsed = launchOperation.input.body.safeParse(body);
  if (!parsed.success)
    throw new VaultError(
      "invalid",
      usesHostLaunch(body.provider) && Object.hasOwn(body, "image")
        ? "Remove the image field and retry. Armada chooses the Docker environment automatically."
        : "Invalid launch request. See the sandbox/launch request schema.",
    );
  const launch = parsed.data;
  if ("hostId" in launch || "snapshotId" in launch) {
    const org = scopedOrg(caller, launch.org);
    const { admitHostLaunch } = options;
    if (!admitHostLaunch) throw new VaultError("unavailable", "Normal Docker launch is not configured.");
    const organization = await resolveOrg(store, userId, org);
    const selected = { ...caller, orgs: caller.orgs.filter((item) => item.orgId === organization.id) };
    if (!encryptionKey) throw new VaultError("unavailable", "Docker launch replay keys are unavailable.");
    const { idempotencyKey, ...request } = launch;
    const requestId = dockerLaunchRequestId(encryptionKey, userId, organization.id, idempotencyKey);
    const { sandbox } = await admitHostLaunch(selected, { ...request, org: organization.id, requestId });
    return { sandbox: { id: sandbox.id, status: sandbox.status } };
  }
  if ("id" in launch) {
    const template = launch;
    const templateOrg = scopedOrg(caller, template.org);
    if (!options.admitModalLaunch) throw new VaultError("unavailable", "Modal launch admission is unavailable.");
    if (template.prompt === undefined && !options.runtimeSend)
      throw new VaultError("unavailable", "Modal runtime idle first send is unavailable.");
    if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
    const base = templateRuntime(options, caller);
    if (!base) throw new VaultError("unavailable", "Template launching unavailable.");
    const {
      provider,
      harness,
      runtimeVersion: _runtimeVersion,
      modalTransport: _runtimeTransport,
      org: _org,
      idempotencyKey,
      ...input
    } = template;
    const organization = await resolveOrg(store, userId, templateOrg);
    const requestKey = `pinned-modal/${createHash("sha256").update(JSON.stringify(idempotencyKey)).digest("hex")}`;
    const receipt = await launchTemplate(
      options.templates,
      caller,
      { ...input, org: organization.id, requestKey },
      {
        ...base,
        explicitModal: true,
        validateDefinition: (definition) => {
          if (definition.provider !== provider || definition.harness !== harness)
            throw new VaultError("invalid", "Modal runtime templates require the selected Modal harness.");
        },
      },
      "template_rest",
    );
    if (receipt.state === "succeeded") {
      const { templateId, revision, revisionId, account, definition, variables, resolvedSkills, golden } =
        receipt.manifest as Record<string, unknown>;
      return pinnedModalLaunchReceipt.parse({
        sandbox: {
          id: receipt.id,
          status: receipt.status,
          templateManifest: {
            templateId,
            revision,
            revisionId,
            golden,
            account,
            definition,
            variables,
            resolvedSkills,
          },
        },
      });
    }
    throw pinnedModalFailure(receipt);
  }
  scopedOrg(caller, launch.org);
  if ("runtimeVersion" in launch) {
    if ("modalTransport" in launch) {
      if (!options.admitModalLaunch) throw new VaultError("unavailable", "Modal launch admission is unavailable.");
      if (launch.prompt === undefined && !options.runtimeSend)
        throw new VaultError("unavailable", "Modal runtime idle first send is unavailable.");
      return launchRoute(options, caller, launch, "modal");
    }
    return { ...(await launchRoute(options, caller, launch, "boat")) };
  }
  return launchRoute(options, caller, launch);
}

export const launchRoutes = defineRoutes("launch", {
  [launchOptionsOperation.route.path.slice("/api/v1/".length)]: {
    methods: [launchOptionsOperation.route.method],
    handler: ({ body, options }) => {
      if (!launchOptionsOperation.input.body.safeParse(body).success)
        throw new VaultError("invalid", "The request is not a JSON object.");
      return readLaunchOptions(options);
    },
  },
  "sandbox/launch": {
    methods: ["POST"],
    responseStatus: (result) =>
      typeof result === "object" && result !== null && freshBoatAdmission in result ? 202 : 200,
    handler: handleSandboxLaunch,
  },
  [controlRouteKey(launchTemplateOperation.route)]: ({ caller, body, options, request }) => {
    configureHostLaunch(options, request);
    if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
    return launchTemplate(options.templates, caller, body, templateRuntime(options, caller), "template_rest");
  },
});
