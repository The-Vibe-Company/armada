import { createHash } from "node:crypto";
import { type Harness, HOST_CAPABILITIES, launchFailureHelp, type VaultStore } from "@armada/core";
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
  LaunchError,
  launchSandbox,
  type ModelChoice,
  resolveBoatKey,
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
import { providerForGolden } from "./golden-control.ts";
import { prepareGoldenLaunchAccount } from "./launch-account-admission.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { readLaunchOptions } from "./launch-options.ts";
import { canonicalLaunchResponse, goldenLaunchResponse, publicLaunchReceipt } from "./launch-response-schemas.ts";
import { withBoatManagementIdentity } from "./observed-boat.ts";
import { controlLaunchReceiptPayload } from "./ordinary-launch-receipts.ts";
import { goldenRuntimePlacement, usesHostLaunch } from "./provider-runtime-admission.ts";
import { type GoldenLaunchTiming, observeGoldenLaunch } from "./request-timing.ts";
import { defineRoutes } from "./routes.ts";
import { ToolApiError } from "./tool-api.ts";

type LaunchControlOptions = Pick<
  ControlOptions,
  | "boatRuntimeLaunch"
  | "runtimeHostFor"
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
  | "dockerLaunch"
  | "admitModalLaunch"
  | "ordinaryLaunchReceipts"
>;

type GoldenLaunchRequest = Extract<LaunchInput, { golden: string }>;

export function launchRoute(
  options: LaunchControlOptions,
  caller: Caller,
  body: GoldenLaunchRequest,
  runtime: boolean | "modal" = false,
) {
  return observeGoldenLaunch("rest", (timing) => launchGolden(options, caller, body, runtime, timing));
}

async function launchGolden(
  options: LaunchControlOptions,
  caller: Caller,
  body: GoldenLaunchRequest,
  runtime: boolean | "modal",
  timing: GoldenLaunchTiming,
) {
  const modalRuntime = runtime === "modal";
  const runtimePolicy = runtime === true ? options.boatRuntimeLaunch : undefined;
  const runtimeHost = runtime === true ? options.runtimeHostFor : undefined;
  if (runtime === true && (!runtimePolicy || !runtimeHost))
    throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
  if (!options.data || !options.providerFor)
    throw new VaultError("unavailable", "Launching is not configured on this server.");
  const { connections, idempotencyKey, golden: name, repo, harness, credentialId } = body;
  const maxActiveChildren = typeof body.armadaAccess === "object" ? body.armadaAccess.maxActiveChildren : undefined;
  const armadaAccess = body.armadaAccess ? (maxActiveChildren === undefined ? {} : { maxActiveChildren }) : undefined;
  if (armadaAccess && !options.sandboxArmadaAccess)
    throw new VaultError("unavailable", "Sandbox Armada access is not enabled on this server.");
  const data = options.data(caller);
  const actor = await launchActor(data, caller, name, body.org, options.store);
  const golden = await goldenForLaunch(data.goldens, actor, name, body.provider);
  resolveRepositoryDir(golden, repo);
  if (armadaAccess && harness !== "codex")
    throw new VaultError("unavailable", "Sandbox Armada access is unavailable for this provider/harness.");
  if (runtime && golden.provider !== (modalRuntime ? "modal" : "boat"))
    throw new VaultError(
      "invalid",
      modalRuntime ? "Modal runtime requires a Modal golden." : "Runtime v1 requires a Boat golden.",
    );
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
  const payload = controlLaunchReceiptPayload(body, golden.id, runtime);
  timing.checkpoint("admission");
  if (HOST_CAPABILITIES[golden.provider].goldenLaunchAdmission) {
    if (!options.admitModalLaunch) throw new VaultError("unavailable", "Modal launch admission is unavailable.");
    const receipt = await options.admitModalLaunch(
      actor,
      golden,
      { ...data, ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}) },
      launchRequest,
      {
        ...(idempotencyKey === undefined ? {} : { request: { key: idempotencyKey, payload } }),
        ...(armadaAccess ? { armadaAccess } : {}),
      },
    );
    return receipt;
  }
  if (idempotencyKey !== undefined && !options.ordinaryLaunchReceipts)
    throw new VaultError("unavailable", "Durable launch receipts are not configured; idempotencyKey is refused.");
  const target = armadaAccess
    ? { ...golden, visibility: "private" as const, sourceGoldenVisibility: golden.visibility }
    : golden;
  const launchOptions: import("@armada/core").LaunchOptions = {
    ...options.launch,
    ...(runtimePolicy ? { runtime: runtimePolicy } : {}),
  };
  const credentials = launchCredentials(
    options.store,
    options.encryptionKey,
    runtime || !options.github
      ? undefined
      : {
          store: options.store,
          app: options.github.app,
          ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
          ...(options.github?.now ? { now: options.github.now } : {}),
        },
    options.modelAuth,
    runtime && options.github ? { ...options.github, store: options.store } : undefined,
  );
  const prepare = async () => {
    const account = await prepareGoldenLaunchAccount(
      actor,
      golden,
      { harness, credentialId },
      credentials,
      launchOptions,
    );
    timing.checkpoint("account_resolution");
    const provider = account.placement
      ? await account.placement.provider(actor, target)
      : runtimeHost
        ? await resolveBoatKey(options.store, options.encryptionKey, {
            userId: caller.userId,
            orgId: actor.orgId,
            visibility: golden.visibility,
          }).then(({ key, scope }) =>
            withBoatManagementIdentity(runtimeHost(key), scope, scope === "org" ? actor.orgId : caller.userId),
          )
        : await providerForGolden(options, caller, target);
    if (provider.id !== golden.provider)
      throw new LaunchError("invalid_request", "Runtime placement must retain the golden provider.");
    timing.checkpoint("provider_resolution");
    return { ...account, provider };
  };
  let prepared: ReturnType<typeof prepare> | undefined;
  const prepareOnce = () => (prepared ??= prepare());
  // The receipt id becomes the sandbox id, so a retried key answers with the same sandbox.
  const dispatch = async (receiptId?: string) => {
    const account = await prepareOnce();
    const connectionLifecycle = account.placement?.connections ?? options.runtimeMcp?.connections;
    timing.checkpoint("receipt_admission");
    const result = await launchSandbox(
      account.provider,
      {
        ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}),
        goldens: data.goldens,
        sandboxes: data.sandboxes,
        ...(connectionLifecycle ? { connections: connectionLifecycle } : {}),
        credentials: account.credentials,
      },
      actor,
      launchRequest,
      {
        ...account.options,
        ...(receiptId ? { newId: () => receiptId } : {}),
        ...(armadaAccess
          ? {
              privateVisibility: true as const,
              beforeStart: async (provider, sandbox, enrolled) => {
                await options.launch?.beforeStart?.(provider, sandbox, enrolled);
                await options.sandboxArmadaAccess?.prepare(provider, sandbox, actor, armadaAccess, enrolled);
              },
            }
          : {}),
      },
    );
    timing.checkpoint("shared_launcher");
    timing.launched(result.sandbox);
    return {
      ...goldenLaunchResponse(result),
      ...(armadaAccess
        ? { armadaAccess: { enabled: true as const, maxActiveChildren: armadaAccess.maxActiveChildren ?? 3 } }
        : {}),
    };
  };
  if (idempotencyKey === undefined) return dispatch();
  const receipts = options.ordinaryLaunchReceipts!;
  const saved = await receipts.replay<Awaited<ReturnType<typeof dispatch>>>(actor, idempotencyKey, payload);
  if (saved) return publicLaunchReceipt(saved.response);
  const { provider } = await prepareOnce();
  const management = await provider.managementIdentity?.();
  const backendId = (await provider.backendIdentity?.())?.id;
  if (!management || !backendId)
    throw new VaultError("unavailable", "This launch path cannot pin allocation authority; idempotencyKey is refused.");
  const authority = {
    target: { provider: target.provider, orgId: target.orgId, visibility: target.visibility, modal: target.modal },
    management,
    backendId,
  };
  // Same key and same request replays the recorded answer; a different request under the key is refused.
  const receipt = await receipts.run(actor, idempotencyKey, payload, dispatch, authority);
  return publicLaunchReceipt(receipt);
}

export async function launchActor(
  data: ScopedData,
  caller: Caller,
  name: string,
  org: string | undefined,
  store: VaultStore,
): Promise<GoldenActor> {
  const selected = org === undefined ? undefined : scopedOrg(caller, org);
  if (selected !== undefined) {
    const ref = selected.trim().toLowerCase();
    const id = UUID.test(ref) ? ref : (await resolveOrg(store, caller.userId, selected)).id;
    const member = caller.orgs.find((item) => item.orgId === id);
    if (!member) throw new VaultError("forbidden", "This token is scoped to another org.");
    return { userId: caller.userId, orgId: member.orgId, role: member.role };
  }
  const holders: string[] = [];
  for (const member of caller.orgs)
    if ((await data.goldens.findByName(member.orgId, name)).length > 0) holders.push(member.orgId);
  if (holders.length > 1) throw new VaultError("invalid", "Name the org for this golden.");
  const member = caller.orgs.find((item) => item.orgId === (holders[0] ?? caller.orgs[0]?.orgId));
  if (!member) throw new VaultError("not_found", "You are not a member of an org.");
  return { userId: caller.userId, orgId: member.orgId, role: member.role };
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
    ...(options.dockerLaunch
      ? {
          launchDocker: (
            body: Record<string, unknown>,
            admission: {
              beforeReserve(tx: import("@armada/core").Sql): Promise<void>;
              beforeStart(): Promise<void>;
            },
          ) => options.dockerLaunch!.launch(caller, body, admission),
        }
      : {}),
    provider: (golden: GoldenRecord) => {
      if (!launch.runtime && !launch.boatRuntime && !goldenRuntimePlacement(launch, golden.provider))
        throw new VaultError("unavailable", "Runtime launch is unavailable for this golden.");
      return providerForGolden(options, caller, golden);
    },
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

function configureDockerLaunch(options: ControlOptions, request: Request | undefined) {
  if (options.dockerLaunch && request) options.configureDockerLaunchRequest?.(request);
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
  "sandbox/launch": async ({ caller, body, options, request }) => {
    if (usesHostLaunch(body.provider)) configureDockerLaunch(options, request);
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
    if (launch.provider === "docker") {
      const org = scopedOrg(caller, launch.org);
      const dockerLaunch = options.dockerLaunch;
      if (!dockerLaunch) throw new VaultError("unavailable", "Normal Docker launch is not configured.");
      const organization = await resolveOrg(store, userId, org);
      const selected = { ...caller, orgs: caller.orgs.filter((item) => item.orgId === organization.id) };
      if (!encryptionKey) throw new VaultError("unavailable", "Docker launch replay keys are unavailable.");
      const { idempotencyKey, ...request } = launch;
      const requestId = dockerLaunchRequestId(encryptionKey, userId, organization.id, idempotencyKey);
      return canonicalLaunchResponse(
        await dockerLaunch.launch(selected, { ...request, org: organization.id, requestId }),
      );
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
      if (!options.boatRuntimeLaunch || !options.runtimeHostFor)
        throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
      return launchRoute(options, caller, launch, true);
    }
    return launchRoute(options, caller, launch);
  },
  [controlRouteKey(launchTemplateOperation.route)]: ({ caller, body, options, request }) => {
    configureDockerLaunch(options, request);
    if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
    return launchTemplate(options.templates, caller, body, templateRuntime(options, caller), "template_rest");
  },
});
