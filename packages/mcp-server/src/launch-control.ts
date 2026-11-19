import type { Harness, VaultStore } from "@armada/core";
import { goldenCompatibilityIds, launchGitHubResponse, sandboxIdentity } from "@armada/core";
import type { LaunchInput } from "@armada/core/contract";
import {
  type GoldenActor,
  type GoldenRecord,
  goldenForLaunch,
  LaunchError,
  type LaunchResult,
  launchSandbox,
  type ModelChoice,
  type Provider,
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
import { providerForGolden } from "./golden-control.ts";
import { prepareGoldenLaunchAccount } from "./launch-account-admission.ts";
import { launchCredentials } from "./launch-credentials.ts";

import { type GoldenLaunchTiming, observeGoldenLaunch } from "./request-timing.ts";

type LaunchControlOptions = Pick<
  ControlOptions,
  | "modalRuntimeLaunch"
  | "boatRuntimeLaunch"
  | "runtimeHostFor"
  | "modalRuntimeHostFor"
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
  const runtimePolicy = modalRuntime ? options.modalRuntimeLaunch : runtime ? options.boatRuntimeLaunch : undefined;
  const runtimeHost = runtime && !modalRuntime ? options.runtimeHostFor : undefined;
  if (runtime && (!runtimePolicy || (!modalRuntime && !runtimeHost)))
    throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
  if (!options.data || !options.providerFor)
    throw new VaultError("unavailable", "Launching is not configured on this server.");
  const { connections, idempotencyKey, golden: name, repo, harness, credentialId } = body;
  if (idempotencyKey !== undefined && !options.ordinaryLaunchReceipts)
    throw new VaultError("unavailable", "Durable launch receipts are not configured; idempotencyKey is refused.");
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
    throw new VaultError("invalid", "Runtime v1 requires a Boat golden.");
  const launchOptions: import("@armada/core").LaunchOptions = {
    ...options.launch,
    ...(runtimePolicy ? (modalRuntime ? { runtime: runtimePolicy } : { boatRuntime: runtimePolicy }) : {}),
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
  timing.checkpoint("admission");
  const prepare = async () => {
    const account = await prepareGoldenLaunchAccount(
      actor,
      golden,
      { harness, credentialId },
      credentials,
      launchOptions,
    );
    timing.checkpoint("account_resolution");
    const provider = modalRuntime
      ? await options.modalRuntimeHostFor!({ ...golden, runtimeTransport: "dialout" }, caller)
      : runtimeHost
        ? runtimeHost(
            (
              await resolveBoatKey(options.store, options.encryptionKey, {
                userId: caller.userId,
                orgId: actor.orgId,
                visibility: golden.visibility,
              })
            ).key,
          )
        : await providerForGolden(
            options,
            caller,
            modalRuntime
              ? { ...golden, runtimeTransport: "dialout" }
              : armadaAccess
                ? { ...golden, visibility: "private", sourceGoldenVisibility: golden.visibility }
                : golden,
          );
    timing.checkpoint("provider_resolution");
    return { ...account, provider };
  };
  let prepared: ReturnType<typeof prepare> | undefined;
  const prepareOnce = () => (prepared ??= prepare());
  const connectionLifecycle = runtime ? options.runtimeMcp?.connections : options.connections;
  // The receipt id becomes the sandbox id, so a retried key answers with the same sandbox.
  const dispatch = async (receiptId?: string) => {
    const account = await prepareOnce();
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
      {
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
      },
      {
        ...account.options,
        ...(receiptId ? { newId: () => receiptId } : {}),
        ...(armadaAccess
          ? {
              privateVisibility: true as const,
              beforeStart: async (provider: Provider, sandbox: import("@armada/core").SandboxRecord) => {
                await options.launch?.beforeStart?.(provider, sandbox);
                await options.sandboxArmadaAccess?.prepare(provider, sandbox, actor, armadaAccess);
              },
            }
          : {}),
      },
    );
    timing.checkpoint("shared_launcher");
    timing.launched(result.sandbox);
    return {
      ...launchJson(result),
      ...(armadaAccess
        ? { armadaAccess: { enabled: true, maxActiveChildren: armadaAccess.maxActiveChildren ?? 3 } }
        : {}),
    };
  };
  if (idempotencyKey === undefined) return dispatch();
  const target = armadaAccess ? { ...golden, visibility: "private" as const } : golden;
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
  const { idempotencyKey: _key, ...request } = body;
  // Same key and same request replays the recorded answer; a different request under the key is refused.
  return options.ordinaryLaunchReceipts!.run(
    actor,
    idempotencyKey,
    {
      surface: "control",
      route: modalRuntime ? "modal-runtime" : runtime ? "boat-runtime" : "native",
      request,
      goldenId: golden.id,
    },
    dispatch,
    authority,
  );
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
  return observeGoldenLaunch(
    surface,
    async (timing) => {
      let freshModal = false;
      const result = await templates.command(
        caller,
        "launch",
        input,
        runtime && {
          ...runtime,
          provider: async (golden) => {
            timing.checkpoint("admission");
            const provider = await runtime.provider(golden);
            timing.checkpoint("provider_resolution");
            freshModal = golden.provider === "modal";
            return provider;
          },
        },
      );
      if (freshModal && result.state === "succeeded" && typeof result.id === "string") {
        timing.launched({ provider: "modal", id: result.id });
      }
      return result;
    },
    "template_execution",
  );
}

/** One launch path for interactive templates and unattended owner-scoped routines. */
export function templateRuntime(options: LaunchControlOptions, caller: Caller) {
  const stores = options.data?.(caller);
  if (!stores) return undefined;
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
    provider: (golden: GoldenRecord) => providerForGolden(options, caller, golden),
    ...(options.launch ? { options: options.launch } : {}),
  };
}

function launchJson(result: LaunchResult) {
  return {
    ...(result.runtime ? { runtime: result.runtime } : {}),
    helper: result.helper,
    sandbox: {
      ...result.sandbox,
      ...sandboxIdentity(result.sandbox),
    },
    golden: {
      ...result.golden,
      ...goldenCompatibilityIds(result.golden),
    },
    promptId: result.promptId ?? null,
    conversationId: result.conversationId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt?.toISOString() ?? null,
    github: launchGitHubResponse(result.github),
  };
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
