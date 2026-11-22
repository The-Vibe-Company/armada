import { providerRateLimitDetails } from "@armada/core";
import { sandboxExtensionLifetime, sandboxRestOperations } from "@armada/core/contract";
import {
  GoldenError,
  isNonMutatingProviderRefusal,
  type Provider,
  ProviderError,
  VaultError,
} from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import { z } from "zod";
import { validateProviderResourceObservation } from "../../core/src/resource-validation.ts";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { selectedCaller } from "./control-caller.ts";
import { optional } from "./control-input.ts";
import type { ServerSandboxPatch, ServerSandboxStore } from "./data.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { summarizeResourceHistory } from "./resource-advice.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";
import { describeToolFailure } from "./tool-failure.ts";
import { isFailedModalLaunch } from "./turns.ts";

const contracts = sandboxRestOperations;
type SandboxRestOperation = keyof typeof contracts;

async function dispatchSandboxRestControl(
  name: SandboxRestOperation,
  route: string,
  caller: Caller,
  body: Record<string, unknown>,
  options: ControlOptions & Required<Pick<ControlOptions, "data" | "providers">>,
) {
  const data = options.data(caller);
  try {
    const result = await run();
    if (!contracts[name].output.safeParse(result).success)
      throw new ToolApiError("internal", `Output validation error for ${route}.`);
    return result;
  } catch (error) {
    const { code, message } = error instanceof ToolApiError ? error : describeToolFailure(error);
    const details =
      error instanceof ProviderError && code === "rate_limited"
        ? providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds })
        : undefined;
    throw new ToolApiError(code, message, details, { cause: error });
  }

  function parse<T extends z.ZodType>(schema: T) {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    throw new ToolApiError("internal", `Input validation error for ${route}: ${z.prettifyError(result.error)}`);
  }

  function parseControl<T extends z.ZodType>(name: string, schema: T) {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    const details = result.error.issues.map((issue) => `${issue.message} at ${issue.path.join(".")}`).join("\n");
    throw new ToolApiError(
      "internal",
      `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${details}`,
    );
  }

  async function run() {
    switch (name) {
      case "resumeSandbox": {
        const { org: _org, ...args } = parseControl("resume", contracts[name].input.body);
        const routed = await options.dockerControls?.invoke(caller, "resume", args);
        if (routed?.handled) return routed.result;
        throw new ToolError("unsupported", "Normal resume is currently available only for Docker sandboxes.");
      }
      case "extendSandbox": {
        const args = parseControl("extend", contracts[name].input.body);
        await data.sandboxes.assertExtensionAllowed?.(args.id).catch((error) => {
          if (error instanceof GoldenError && ["not_found", "forbidden"].includes(error.code))
            throw new ToolError(
              error.code === "forbidden" ? "extension_not_allowed" : "extension_not_found",
              error.message,
            );
          throw error;
        });
        const sandbox = await data.sandboxes.get(args.id);
        if (!sandbox) throw new ToolError("extension_not_found", "Sandbox not found or not accessible.");
        const provider = await options.providers.resolve(sandbox, { userId: sandbox.ownerId }).catch((error) => {
          if (error instanceof ProviderError && error.code === "forbidden")
            throw new ToolError("extension_not_allowed", "You are not allowed to extend this sandbox.");
          throw error;
        });
        return extendSandbox(
          data.sandboxes,
          sandbox,
          provider,
          args.ttlSeconds ?? args.ttl_seconds,
          () => options.connections?.renewLifetime?.(provider, sandbox.id) ?? Promise.resolve(),
        );
      }
      case "deleteSandbox": {
        const { input } = contracts[name];
        const { id, requestId } = parseControl("delete", input.query.extend(input.path));
        const args = { id, request_id: requestId?.toLowerCase() };
        const routed = await options.dockerControls?.invoke(caller, "delete", args);
        if (routed?.handled) return routed.result;
        return deleteSandboxWithActivity(data.sandboxes, options.providers, args.id);
      }
      case "postSandboxCheckpointRuntimeV1": {
        const { org: _org, ...args } = parse(contracts[name].input.body);
        if (!options.runtimeCheckpoint) throw new ToolApiError("unsupported", "Runtime checkpoint is unavailable.");
        return options.runtimeCheckpoint(caller, args);
      }
      case "postSandboxResumeRuntimeV1": {
        refuseConversationSelector(body);
        const { org: _org, ...args } = parse(contracts[name].input.body);
        if (!options.runtimeResume) throw new ToolApiError("unsupported", "Runtime resume is unavailable.");
        return options.runtimeResume(caller, args);
      }
      case "recoverSandbox": {
        const args = parse(contracts[name].input.body);
        const found = await data.sandboxes.get(args.id);
        if (!found) throw new ToolApiError("not_found", "No such sandbox.");
        return { archive: (await data.sandboxes.readWorkRecovery?.(found.id, args.recovery_id)) ?? null };
      }
      case "sandboxAdvice": {
        const args = parse(contracts[name].input.body);
        const found = await data.sandboxes.get(args.id);
        if (!found) throw new ToolApiError("not_found", `No sandbox with id '${args.id}' that you can see.`);
        const store = data.resourceObservations;
        if (!store)
          throw new ToolApiError("dependency_unavailable", "Resource observation persistence is unavailable.");
        const now = options.now ?? (() => new Date());
        const admission =
          found.resourceProject && found.machineSize?.capacity && ["ready", "running"].includes(found.status)
            ? await store.claim(found.id, now())
            : null;
        if (admission) {
          let observation = null;
          try {
            const provider = await measureRequestPhase(options.timing, "provider", () =>
              options.providers.resolve(found, caller),
            );
            observation = (await provider.observeResources?.(found.providerSandboxId)) ?? null;
          } catch {}
          if (
            observation &&
            validateProviderResourceObservation(observation) &&
            observation.reading.cpuLogicalCpus !== null &&
            observation.reading.memoryTotalBytes !== null
          ) {
            try {
              await store.append(found.id, observation, now(), admission);
            } catch (error) {
              if (!(error instanceof GoldenError && error.code === "conflict")) throw error;
            }
          }
        }
        return { advice: summarizeResourceHistory(await store.history(found.id, now()), now()) };
      }
    }
  }
}

async function observeBoatDrainDeletion(
  boat: Partial<BoatProvider>,
  sandboxId: string,
  generation: number | undefined,
  operationId: string,
  signal: AbortSignal,
) {
  if (!boat.observeSandboxDeletion || generation === undefined)
    throw new ToolError("unavailable", "Native Boat deletion observation is unavailable.");
  return boat.observeSandboxDeletion({ sandboxId, generation, operationId, signal });
}

export async function deleteSandboxWithActivity(
  sandboxes: ServerSandboxStore,
  providers: Pick<NonNullable<ControlOptions["providers"]>, "resolve"> & {
    beforeNativeDrainDelete?(
      provider: Provider,
      sandboxId: string,
      placement: string,
      generation: number,
    ): Promise<void>;
  },
  id: string,
  mode?: "native-drain",
) {
  const nativeDrain = mode === "native-drain";
  if (!sandboxes.assertDeletionAllowed) throw new ToolError("unavailable", "Sandbox deletion is not configured.");
  await sandboxes.assertDeletionAllowed(id);
  const found = await sandboxes.get(id);
  if (!found) throw new ToolError("not_found", `No sandbox with id '${id}' that you can see.`);
  if (found.status === "deleted") return { id: found.id, status: "deleted" as const };
  if (nativeDrain && !found.providerSandboxId)
    throw new ToolError("conflict", "Native drain requires an exact provider placement.");
  const admission: ServerSandboxPatch = {
    deleteRequested: true,
    ...(nativeDrain ? { nativeDrainAdmission: { provider: found.provider, placement: found.providerSandboxId } } : {}),
  };
  const exitConfirmed = !nativeDrain && isFailedModalLaunch(found) && found.stoppedAt !== null;
  const provider =
    found.providerSandboxId && !exitConfirmed ? await providers.resolve(found, { userId: found.ownerId }) : null;
  const failurePatch = (error: unknown) => {
    if (found.provider === "modal" || isNonMutatingProviderRefusal(error)) return {};
    throw error;
  };
  return sandboxActivity(
    sandboxes,
    found,
    admission,
    async (signal, activityToken) => {
      signal.throwIfAborted();
      if (provider) {
        try {
          const target = {
            sandboxId: found.providerSandboxId,
            ...(found.lifecycleGeneration !== undefined ? { generation: found.lifecycleGeneration + 1 } : {}),
          };
          let operationId: string | null = null;
          if (nativeDrain) {
            const generation = target.generation;
            const dispatch = sandboxes.nativeDrainDispatch?.bind(sandboxes);
            if (!dispatch || generation === undefined)
              throw new ToolError("unavailable", "Native drain deletion evidence is unavailable.");
            const prepare = providers.beforeNativeDrainDelete;
            if (prepare) {
              operationId = await dispatch(id, target.sandboxId, generation, activityToken, "inspect");
              signal.throwIfAborted();
              if (operationId === null) {
                await prepare(provider, id, target.sandboxId, generation);
                signal.throwIfAborted();
              }
            }
            if (operationId === null)
              operationId = await dispatch(id, target.sandboxId, generation, activityToken, "claim");
            signal.throwIfAborted();
          }
          const boat = provider as Partial<BoatProvider>;
          const receipt =
            operationId !== null
              ? await observeBoatDrainDeletion(boat, target.sandboxId, target.generation, operationId, signal)
              : await provider.delete(target);
          if (nativeDrain && operationId === null && receipt.operationId?.trim()) {
            signal.throwIfAborted();
            await sandboxes.update(id, {
              nativeDrainDeleteOperation: {
                provider: found.provider,
                placement: target.sandboxId,
                id: receipt.operationId,
              },
              ...(target.generation === undefined ? {} : { expectedGeneration: target.generation }),
              activityToken,
            });
          }
          if (!["deleted", "completed"].includes(receipt.status))
            throw new ToolError(
              "conflict",
              "Provider deletion is pending. Retry deletion to confirm completion; do not resume this sandbox.",
            );
        } catch (error) {
          if (nativeDrain || !(error instanceof ProviderError && error.code === "not_found")) throw error;
        }
      }
      const patch: ServerSandboxPatch = { deleteCompleted: true, ...(nativeDrain ? { nativeDrain: true } : {}) };
      return { result: { id: found.id, status: "deleted" as const }, patch };
    },
    nativeDrain ? undefined : { failurePatch },
  );
}

const { deleteSandbox, ...postOperations } = sandboxRestOperations;

export const sandboxRestRoutes = defineRoutes("sandbox REST", {
  ...Object.fromEntries(
    Object.values(postOperations).map(
      ({ name, route }) =>
        [
          route.path.slice("/api/v1/".length),
          { methods: [route.method], handler: (context: ControlRouteContext) => sandboxRestRoute(name, context) },
        ] as const,
    ),
  ),
  [deleteSandbox.route.path.slice("/api/v1/".length)]: {
    methods: [deleteSandbox.route.method],
    pattern: /^sandboxes\/[0-9a-f-]+$/i,
    readBody(request) {
      const url = new URL(request.url);
      return {
        id: url.pathname.split("/").at(-1),
        ...Object.fromEntries(
          Object.keys(deleteSandbox.input.query.shape).map((key) => [key, url.searchParams.get(key) ?? undefined]),
        ),
      };
    },
    handler: (context) => sandboxRestRoute(deleteSandbox.name, context),
  },
});

async function sandboxRestRoute(name: SandboxRestOperation, { route, caller, body, options }: ControlRouteContext) {
  if (name === "extendSandbox") {
    if (Object.hasOwn(body, "ttlSeconds") && Object.hasOwn(body, "ttl_seconds"))
      throw new VaultError("invalid", "Send one lifetime field: ttlSeconds.");
    const ttl = Object.hasOwn(body, "ttlSeconds") ? body.ttlSeconds : body.ttl_seconds;
    const parsed = sandboxExtensionLifetime.safeParse(ttl);
    if (!parsed.success) {
      if (Number.isSafeInteger(ttl) && parsed.error.issues.some((issue) => issue.code === "too_big"))
        throw new ToolApiError("extension_maximum", "Requested lifetime exceeds the server maximum.");
      throw new VaultError(
        "invalid",
        "ttlSeconds must be a positive whole number of seconds within the server maximum.",
      );
    }
  }
  const { data, providers } = options;
  if (!data || !providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
  const org = optional(body, "org");
  const scopedCaller = await selectedCaller(options, caller, org);
  return dispatchSandboxRestControl(name, route, scopedCaller, body, { ...options, data, providers });
}
