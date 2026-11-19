import { MAX_SANDBOX_EXTENSION_TTL_SECONDS, providerRateLimitDetails } from "@armada/core";
import { GoldenError, isNonMutatingProviderRefusal, ProviderError, VaultError } from "@armada/core/server";
import { z } from "zod";
import { validateProviderResourceObservation } from "../../core/src/resource-validation.ts";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { selectedCaller } from "./control-caller.ts";
import { optional } from "./control-input.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { summarizeResourceHistory } from "./resource-advice.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { ToolApiError } from "./tool-api.ts";
import { ToolError } from "./tool-error.ts";
import { describeToolFailure } from "./tool-failure.ts";

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");
const runtimeRequest = z.object({ id, request_id: z.string().uuid(), runtimeVersion: z.literal(1) });
const runtime = z.object({ kind: z.literal("armada"), epoch: z.string() });

export const SANDBOX_REST_CONTRACTS = {
  "sandbox/resume": {
    description:
      "Owner-only. Restarts the same Docker allocation with fresh runtime enrolment, keeping history and the original TTL. Reuse request_id after uncertainty.",
    input: z.object({ id, request_id: z.string().uuid() }),
    output: z.object({ id: z.string(), status: z.literal("ready") }),
  },
  "sandbox/extend": {
    description:
      "Set a later expiry, measured from now. Owner/admin only. Modal extensions must fit inside the current physical machine lifetime; stop and resume for a new physical lifetime.",
    input: z.object({ id, ttlSeconds: z.number().int().positive().max(MAX_SANDBOX_EXTENSION_TTL_SECONDS) }),
    output: z.object({ id: z.string(), expiresAt: z.string(), ttlSeconds: z.number().int() }),
  },
  "sandbox/delete": {
    description:
      "Owner/admin only. Permanently removes provider resources and recovery archives. Stop first. Legacy orchestrator parents and children are refused; ordinary delegated children require a deleted parent.",
    input: z.object({ id, request_id: z.string().uuid().optional() }),
    output: z.object({ id: z.string(), status: z.literal("deleted") }),
  },
  "sandbox/advice": {
    description:
      "Collects one bounded read-only VM observation and reports the last ten comparable repository sessions. Missing evidence causes abstention; never resizes or changes defaults.",
    input: z.object({ id }),
    output: z.object({ advice: z.unknown() }),
  },
  "sandbox/recovery": {
    description: "Owner/admin only. Returns sensitive base64 recovery archive; never log it.",
    input: z.object({ id, recovery_id: z.string().uuid().optional() }),
    output: z.object({ archive: z.string().nullable() }),
  },
  "sandbox/checkpoint-runtime-v1": {
    input: runtimeRequest,
    output: z.object({
      id: z.string(),
      requestId: z.string(),
      runtime,
      checkpoint: z.object({
        state: z.literal("complete"),
        watermark: z.number().int().nonnegative(),
        acknowledgedSequence: z.number().int().nonnegative(),
      }),
    }),
  },
  "sandbox/resume-runtime-v1": {
    input: runtimeRequest.extend({
      prompt: z.string().min(1),
    }),
    output: z.object({
      id: z.string(),
      requestId: z.string(),
      promptId: z.string(),
      conversationId: z.string(),
      status: z.enum(["queued", "running", "finished", "failed", "interrupted"]),
      resumed: z.literal(true),
      runtime,
      sourceCheckpoint: z.object({
        epoch: z.string(),
        watermark: z.number().int().nonnegative(),
        empty: z.literal(true).optional(),
      }),
    }),
  },
};

type SandboxRestRoute = keyof typeof SANDBOX_REST_CONTRACTS;
export function isSandboxRestControl(route: string): route is SandboxRestRoute {
  return Object.hasOwn(SANDBOX_REST_CONTRACTS, route);
}

export async function dispatchSandboxRestControl(
  route: SandboxRestRoute,
  caller: Caller,
  body: Record<string, unknown>,
  options: ControlOptions & Required<Pick<ControlOptions, "data" | "providers">>,
) {
  const data = options.data(caller);
  try {
    const result = await run();
    if (!SANDBOX_REST_CONTRACTS[route].output.safeParse(result).success)
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
    switch (route) {
      case "sandbox/resume": {
        const args = parseControl("resume", SANDBOX_REST_CONTRACTS[route].input);
        const routed = await options.dockerControls?.invoke(caller, "resume", args);
        if (routed?.handled) return routed.result;
        throw new ToolError("unsupported", "Normal resume is currently available only for Docker sandboxes.");
      }
      case "sandbox/extend": {
        const args = parseControl("extend", SANDBOX_REST_CONTRACTS[route].input);
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
          args.ttlSeconds,
          () => options.connections?.renewLifetime?.(provider, sandbox.id) ?? Promise.resolve(),
        );
      }
      case "sandbox/delete": {
        const args = parseControl("delete", SANDBOX_REST_CONTRACTS[route].input);
        const routed = await options.dockerControls?.invoke(caller, "delete", args);
        if (routed?.handled) return routed.result;
        if (!data.sandboxes.assertDeletionAllowed)
          throw new ToolError("unavailable", "Sandbox deletion is not configured.");
        await data.sandboxes.assertDeletionAllowed(args.id);
        const found = await data.sandboxes.get(args.id);
        if (!found) throw new ToolError("not_found", `No sandbox with id '${args.id}' that you can see.`);
        if (found.status === "deleted") return { id: found.id, status: "deleted" as const };
        const provider = found.providerSandboxId
          ? await options.providers.resolve(found, { userId: found.ownerId })
          : null;
        const now = options.now ?? (() => new Date());
        const failurePatch = (error: unknown) => {
          if (found.provider === "modal" || isNonMutatingProviderRefusal(error)) return {};
          throw error;
        };
        return sandboxActivity(
          data.sandboxes,
          found,
          { deleteRequested: true },
          async (signal) => {
            signal.throwIfAborted();
            if (provider) {
              try {
                const receipt = await provider.delete({ sandboxId: found.providerSandboxId });
                if (!["deleted", "completed"].includes(receipt.status))
                  throw new ToolError(
                    "conflict",
                    "Provider deletion is pending. Retry deletion to confirm completion; do not resume this sandbox.",
                  );
              } catch (error) {
                if (!(error instanceof ProviderError && error.code === "not_found")) throw error;
              }
            }
            return {
              result: { id: found.id, status: "deleted" as const },
              patch: {
                status: "deleted",
                deletedAt: now().toISOString(),
                ...(found.stoppedAt === null ? { usageRuntimeUnknown: true } : {}),
              },
            };
          },
          { failurePatch },
        );
      }
      case "sandbox/checkpoint-runtime-v1": {
        const args = parse(SANDBOX_REST_CONTRACTS[route].input);
        if (!options.runtimeCheckpoint) throw new ToolApiError("unsupported", "Runtime checkpoint is unavailable.");
        return options.runtimeCheckpoint(caller, args);
      }
      case "sandbox/resume-runtime-v1": {
        refuseConversationSelector(body);
        const args = parse(SANDBOX_REST_CONTRACTS[route].input);
        if (!options.runtimeResume) throw new ToolApiError("unsupported", "Runtime resume is unavailable.");
        return options.runtimeResume(caller, args);
      }
      case "sandbox/recovery": {
        const args = parse(SANDBOX_REST_CONTRACTS[route].input);
        const found = await data.sandboxes.get(args.id);
        if (!found) throw new ToolApiError("not_found", "No such sandbox.");
        return { archive: (await data.sandboxes.readWorkRecovery?.(found.id, args.recovery_id)) ?? null };
      }
      case "sandbox/advice": {
        const args = parse(SANDBOX_REST_CONTRACTS[route].input);
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

export const sandboxRestRoutes = defineRoutes(
  "sandbox REST",
  Object.fromEntries(
    Object.keys(SANDBOX_REST_CONTRACTS)
      .filter(isSandboxRestControl)
      .map((route) => [route, (context: ControlRouteContext) => sandboxRestRoute(route, context)]),
  ),
);

async function sandboxRestRoute(route: SandboxRestRoute, { caller, body, options }: ControlRouteContext) {
  if (route === "sandbox/extend") {
    if (Object.hasOwn(body, "ttlSeconds") && Object.hasOwn(body, "ttl_seconds"))
      throw new VaultError("invalid", "Send one lifetime field: ttlSeconds.");
    const ttl = Object.hasOwn(body, "ttlSeconds") ? body.ttlSeconds : body.ttl_seconds;
    if (Number.isSafeInteger(ttl) && Number(ttl) > MAX_SANDBOX_EXTENSION_TTL_SECONDS)
      throw new ToolApiError("extension_maximum", "Requested lifetime exceeds the server maximum.");
    if (!Number.isSafeInteger(ttl) || Number(ttl) < 1)
      throw new VaultError(
        "invalid",
        "ttlSeconds must be a positive whole number of seconds within the server maximum.",
      );
    body = { ...body, ttlSeconds: ttl };
  }
  const { data, providers } = options;
  if (!data || !providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
  const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
  return dispatchSandboxRestControl(route, scopedCaller, body, { ...options, data, providers });
}
