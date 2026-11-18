import { providerRateLimitDetails } from "@armada/core";
import { GoldenError, ProviderError } from "@armada/core/server";
import { z } from "zod";
import { validateProviderResourceObservation } from "../../core/src/resource-validation.ts";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { summarizeResourceHistory } from "./resource-advice.ts";
import { ToolApiError } from "./tool-api.ts";
import { describeToolFailure } from "./tools.ts";

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");
const runtimeRequest = z.object({ id, request_id: z.string().uuid(), runtimeVersion: z.literal(1) });
const runtime = z.object({ kind: z.literal("armada"), epoch: z.string() });

export const SANDBOX_REST_CONTRACTS = {
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
      conversation_id: z.string().min(1).optional(),
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

  async function run() {
    switch (route) {
      case "sandbox/checkpoint-runtime-v1": {
        const args = parse(SANDBOX_REST_CONTRACTS[route].input);
        if (!options.runtimeCheckpoint) throw new ToolApiError("unsupported", "Runtime checkpoint is unavailable.");
        return options.runtimeCheckpoint(caller, args);
      }
      case "sandbox/resume-runtime-v1": {
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
