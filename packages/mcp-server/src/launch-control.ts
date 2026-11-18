import type { Harness } from "@armada/core";
import {
  goldenCompatibilityIds,
  isExternalRef,
  isHarness,
  launchGitHubResponse,
  parseMachineSize,
  sandboxIdentity,
} from "@armada/core";
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
  resolveRepositoryDir,
  VaultError,
} from "@armada/core/server";
import type { z } from "zod";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg } from "./control-caller.ts";
import { isLaunchConnectionList, optional, required, requiredNumber } from "./control-input.ts";
import type { ScopedData } from "./data.ts";
import { providerForGolden } from "./golden-control.ts";
import { launchCredentials } from "./launch-credentials.ts";
import type { REST_LAUNCH_RESPONSE } from "./launch-response-schemas.ts";
import { parseSandboxArmadaAccess } from "./sandbox-armada-access.ts";

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

export async function launchRoute(
  options: LaunchControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
  runtime: boolean | "modal" = false,
): Promise<unknown> {
  const modalRuntime = runtime === "modal";
  const runtimePolicy = modalRuntime ? options.modalRuntimeLaunch : runtime ? options.boatRuntimeLaunch : undefined;
  const runtimeHost = runtime && !modalRuntime ? options.runtimeHostFor : undefined;
  if (runtime && (!runtimePolicy || (!modalRuntime && !runtimeHost)))
    throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
  if (!runtime && (body.boatRuntime !== undefined || body.runtimeTransport !== undefined))
    throw new VaultError("invalid", "Use sandbox/launch-runtime-v1 for experimental runtime selection.");
  if (!options.data || !options.providerFor)
    throw new VaultError("unavailable", "Launching is not configured on this server.");
  if (body.visibility !== undefined && body.visibility !== "private" && body.visibility !== "org")
    throw new VaultError("invalid", "Visibility is private or org.");
  const connections = body.connections;
  if (connections !== undefined && !isLaunchConnectionList(connections))
    throw new VaultError("invalid", "connections must contain at most 100 connection UUIDs.");
  const idempotencyKey = body.idempotencyKey;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 128)
  )
    throw new VaultError("invalid", "idempotencyKey must be 16 to 128 characters.");
  if (body.stopWhenWorkMerged !== undefined && typeof body.stopWhenWorkMerged !== "boolean")
    throw new VaultError("invalid", "stopWhenWorkMerged must be a boolean.");
  if (body.externalRef !== undefined && !isExternalRef(body.externalRef))
    throw new VaultError("invalid", "externalRef must be 1 to 200 characters without control characters.");
  if (idempotencyKey !== undefined && !options.ordinaryLaunchReceipts)
    throw new VaultError("unavailable", "Durable launch receipts are not configured; idempotencyKey is refused.");
  const armadaAccess = parseSandboxArmadaAccess(body.armadaAccess);
  if (armadaAccess && !options.sandboxArmadaAccess)
    throw new VaultError("unavailable", "Sandbox Armada access is not enabled on this server.");
  const name = required(body, "golden");
  const repo = body.repo === undefined ? undefined : required(body, "repo");
  const harness = required(body, "harness");
  if (!isHarness(harness)) throw new VaultError("invalid", "The agent is claude or codex.");
  const data = options.data(caller);
  const actor = await launchActor(data, caller, name, optional(body, "org"));
  const golden = await goldenForLaunch(
    data.goldens,
    actor,
    name,
    optional(body, "provider") as "boat" | "modal" | undefined,
  );
  resolveRepositoryDir(golden, optional(body, "repo"));
  if (armadaAccess && harness !== "codex")
    throw new VaultError("unavailable", "Sandbox Armada access is unavailable for this provider/harness.");
  if (runtime && golden.provider !== (modalRuntime ? "modal" : "boat"))
    throw new VaultError("invalid", "Runtime v1 requires a Boat golden.");
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
  const connectionLifecycle = runtime ? options.runtimeMcp?.connections : options.connections;
  // The receipt id becomes the sandbox id, so a retried key answers with the same sandbox.
  const dispatch = async (receiptId?: string) => {
    const result = await launchSandbox(
      provider,
      {
        ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}),
        goldens: data.goldens,
        sandboxes: data.sandboxes,
        ...(connectionLifecycle ? { connections: connectionLifecycle } : {}),
        credentials: launchCredentials(
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
        ),
      },
      actor,
      {
        ...(body.credentialId !== undefined ? { credentialId: required(body, "credentialId") } : {}),
        golden: name,
        ...(body.size === undefined ? {} : { size: parseMachineSize(body.size) }),
        provider: golden.provider,
        ...(repo === undefined ? {} : { repo }),
        ...(body.visibility === undefined ? {} : { visibility: body.visibility as "private" | "org" }),
        ...(body.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: body.skipSkillDefaults as boolean }),
        ...(body.skills === undefined ? {} : { skills: body.skills as string[] }),
        ...(body.helperCapabilities === undefined ? {} : { helperCapabilities: body.helperCapabilities as string[] }),
        ...(connections === undefined ? {} : { connections }),
        ...modelChoice(harness, optional(body, "model"), optional(body, "reasoningEffort")),
        harness,
        ...(optional(body, "prompt") === undefined ? {} : { prompt: required(body, "prompt") }),
        ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: requiredNumber(body, "ttlSeconds") }),
        ...(body.stopWhenWorkMerged === false ? { stopWhenWorkMerged: false } : {}),
        ...(body.externalRef === undefined ? {} : { externalRef: body.externalRef as string }),
      },
      {
        ...options.launch,
        ...(receiptId ? { newId: () => receiptId } : {}),
        ...(runtimePolicy ? (modalRuntime ? { runtime: runtimePolicy } : { boatRuntime: runtimePolicy }) : {}),
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
    return {
      ...launchJson(result),
      ...(armadaAccess
        ? { armadaAccess: { enabled: true, maxActiveChildren: armadaAccess.maxActiveChildren ?? 3 } }
        : {}),
    };
  };
  if (idempotencyKey === undefined) return dispatch();
  const target = armadaAccess ? { ...golden, visibility: "private" as const } : golden;
  const management = await provider.managementIdentity?.();
  const backendId = (await provider.backendIdentity?.())?.id;
  if (!management || !backendId)
    throw new VaultError("unavailable", "This launch path cannot pin allocation authority; idempotencyKey is refused.");
  const { idempotencyKey: _key, ...request } = body;
  // Same key and same request replays the recorded answer; a different request under the key is refused.
  return options.ordinaryLaunchReceipts!.run(
    actor,
    idempotencyKey as string,
    {
      surface: "control",
      route: modalRuntime ? "modal-runtime" : runtime ? "boat-runtime" : "native",
      request,
      goldenId: golden.id,
    },
    dispatch,
    {
      target: { provider: target.provider, orgId: target.orgId, visibility: target.visibility, modal: target.modal },
      management,
      backendId,
    },
  );
}

export async function launchActor(
  data: ScopedData,
  caller: Caller,
  name: string,
  org: string | undefined,
): Promise<GoldenActor> {
  const selected = org === undefined ? undefined : scopedOrg(caller, org);
  if (selected !== undefined) {
    const member = caller.orgs.find((item) => item.orgId === selected);
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
  } satisfies z.input<typeof REST_LAUNCH_RESPONSE>;
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
