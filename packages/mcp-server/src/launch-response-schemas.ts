import type { GoldenErrorCode } from "@armada/core";
import { z } from "zod";

/**
 * Public HTTP 200 bodies of the two REST launch routes. Their MCP tools have no typed
 * output, so the OpenAPI description is generated from these schemas, and the
 * handlers' representative responses are tested against them.
 * Records stay open: providers and later releases add fields.
 */
export const REST_LAUNCH_RESPONSE = z
  .object({
    sandbox: z
      .object({
        id: z.string().describe("Armada sandbox ID: pass it as `id` to status, send, wait, logs, exec and stop."),
        provider: z.string(),
        providerSandboxId: z.string(),
        status: z.string(),
      })
      .passthrough(),
    golden: z
      .object({ id: z.string(), name: z.string() })
      .passthrough()
      .nullable()
      .describe("Null for Docker launches, which have no golden."),
    promptId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    ttlSeconds: z.number(),
    expiresAt: z.string().nullable(),
    github: z.object({ status: z.string() }).passthrough(),
    helper: z.unknown().optional(),
    runtime: z
      .object({ kind: z.literal("armada"), epoch: z.string() })
      .nullable()
      .optional(),
  })
  .passthrough();

/** States of `public.template_launch_requests.state`. */
const TEMPLATE_LAUNCH_STATES = ["claimed", "allocating", "succeeded", "failed", "reconciling"] as const;

export const TEMPLATE_LAUNCH_RECEIPT = z
  .object({
    requestId: z.string().describe("The durable request. Replay the same requestKey to read it again."),
    state: z.enum(TEMPLATE_LAUNCH_STATES),
    id: z.string().describe("Armada sandbox ID reserved for this request."),
    reason: z.string().nullable().optional(),
    message: z.string().optional(),
    provider: z.string().optional(),
    providerSandboxId: z.string().optional(),
    status: z.string().optional(),
    promptId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
  })
  .passthrough()
  .describe("A recorded launch request.");

/** Every GoldenErrorCode, checked both ways at compile time. */
const GOLDEN_ERROR_CODES = [
  "invalid_config",
  "forbidden",
  "not_found",
  "conflict",
  "setup_failed",
  "snapshot_failed",
  "build_failed",
] as const satisfies readonly GoldenErrorCode[];
const goldenCodesComplete: [Exclude<GoldenErrorCode, (typeof GOLDEN_ERROR_CODES)[number]>] extends [never]
  ? true
  : never = true;
void goldenCodesComplete;

/** Golden admission refused before any request was recorded: nothing was launched and there is no requestId. */
export const TEMPLATE_LAUNCH_REFUSAL = z
  .strictObject({
    state: z.literal("failed"),
    reason: z.enum(GOLDEN_ERROR_CODES),
    message: z.string(),
  })
  .describe("Golden admission refused the launch before a request was recorded. Nothing was launched.");

export const TEMPLATE_LAUNCH_RESPONSE = z
  .union([TEMPLATE_LAUNCH_RECEIPT, TEMPLATE_LAUNCH_REFUSAL])
  .describe("A receipt has requestId; a pre-admission refusal has none.");

export function responseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
}
