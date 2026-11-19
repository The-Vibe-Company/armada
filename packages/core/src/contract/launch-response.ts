import { z } from "zod";
import type { GoldenErrorCode } from "../golden-config.ts";

/**
 * Shared HTTP 200 envelope for golden and Docker launches.
 * Nested records stay open to provider-specific fields.
 */
export const launchEnvelope = z.strictObject({
  sandbox: z
    .object({
      id: z.string().describe("Armada sandbox ID: pass it as `id` to status, send, wait, logs, exec and stop."),
      provider: z.string(),
      providerSandboxId: z.string(),
      status: z.string(),
      externalRef: z.string().optional().describe("Opaque caller reference, when provided."),
    })
    .passthrough(),
  golden: z
    .object({ id: z.string(), name: z.string() })
    .passthrough()
    .nullable()
    .describe("Null for Docker launches, which have no golden."),
  promptId: z.string().nullable(),
  conversationId: z.string().nullable(),
  ttlSeconds: z.number(),
  expiresAt: z.string().nullable(),
  github: z.object({ status: z.string() }).passthrough(),
  helper: z.object({ status: z.string() }).passthrough().nullable(),
  runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).nullable(),
});

/** States of `public.template_launch_requests.state`. */
const TEMPLATE_LAUNCH_STATES = ["claimed", "allocating", "succeeded", "failed", "reconciling"] as const;

const TEMPLATE_LAUNCH_RECEIPT = z
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
const TEMPLATE_LAUNCH_REFUSAL = z
  .strictObject({
    state: z.literal("failed"),
    reason: z.enum(GOLDEN_ERROR_CODES),
    message: z.string(),
  })
  .describe("Golden admission refused the launch before a request was recorded. Nothing was launched.");

export const templateLaunchResponse = z
  .union([TEMPLATE_LAUNCH_RECEIPT, TEMPLATE_LAUNCH_REFUSAL])
  .describe("A receipt has requestId; a pre-admission refusal has none.");

export const launchOutput = z.union([launchEnvelope, templateLaunchResponse]);

export type LaunchEnvelope = z.output<typeof launchEnvelope>;
