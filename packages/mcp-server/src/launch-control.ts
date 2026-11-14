import type { Harness } from "@armada/core";
import {
  goldenCompatibilityIds,
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
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg } from "./control-caller.ts";
import { optional, required, requiredNumber, UUID } from "./control-input.ts";
import type { ScopedData } from "./data.ts";
import { providerForGolden } from "./golden-control.ts";
import { launchCredentials } from "./launch-credentials.ts";
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
  if (
    body.connections !== undefined &&
    (!Array.isArray(body.connections) ||
      body.connections.length > 100 ||
      body.connections.some((id) => typeof id !== "string" || !UUID.test(id)))
  )
    throw new VaultError("invalid", "connections must contain at most 100 connection UUIDs.");
  const armadaAccess = parseSandboxArmadaAccess(body.armadaAccess);
  if (armadaAccess && !options.sandboxArmadaAccess)
    throw new VaultError("unavailable", "Sandbox Armada access is not enabled on this server.");
  if (armadaAccess && (typeof body.credentialId !== "string" || !UUID.test(body.credentialId)))
    throw new VaultError("invalid", "Sandbox Armada access requires an explicit credentialId.");
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
        runtime
          ? undefined
          : {
              store: options.store,
              app: options.github?.app ?? null,
              ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
              ...(options.github?.now ? { now: options.github.now } : {}),
            },
        options.modelAuth,
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
      ...(body.connections === undefined ? {} : { connections: body.connections as string[] }),
      ...modelChoice(harness, optional(body, "model"), optional(body, "reasoningEffort")),
      harness,
      ...(optional(body, "prompt") === undefined ? {} : { prompt: required(body, "prompt") }),
      ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: requiredNumber(body, "ttlSeconds") }),
    },
    {
      ...options.launch,
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
  };
}

function modelChoice(harness: Harness, model: string | undefined, reasoningEffort: string | undefined): ModelChoice {
  try {
    return resolveModelChoice(harness, { model, reasoningEffort });
  } catch (error) {
    if (error instanceof LaunchError) throw new VaultError("invalid", error.message);
    throw error;
  }
}
