import type { GoldenErrorCode } from "@armada/core";
import { z } from "zod";
import { GOLDEN_OUTPUT, LOGS_OUTPUT } from "./tools.ts";

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

/** `golden/list`: the MCP golden record plus the build warnings the REST handler adds. */
export const GOLDEN_LIST_RESPONSE = z.object({
  goldens: z.array(
    GOLDEN_OUTPUT.extend({
      buildWarnings: z.array(z.string()).describe("Non-blocking findings from the golden's last build."),
    }),
  ),
});

const versions = z
  .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
  .describe("Server feature versions for this provider path. Clients must tolerate unknown keys.");

/**
 * `launch/options` (core `LaunchOptionsResponse`): what a launch can ask for on this server.
 * Identifiers stay plain strings so clients tolerate providers, harnesses and sizes added later.
 */
export const LAUNCH_OPTIONS_RESPONSE = z
  .object({
    harnesses: z.array(
      z
        .object({
          id: z.string(),
          credentialKinds: z.array(z.string()),
          defaultModel: z.string(),
          defaultReasoningEffort: z.string(),
          reasoningEfforts: z.array(z.string()),
          models: z.array(
            z.object({ id: z.string(), label: z.string(), reasoningEfforts: z.array(z.string()) }).passthrough(),
          ),
        })
        .passthrough(),
    ),
    machineSizes: z.array(z.string()),
    ttl: z
      .object({ defaultSeconds: z.number(), maxSeconds: z.record(z.string(), z.number()) })
      .passthrough()
      .describe("Launch TTL default and per-provider maximums, in seconds."),
    providers: z.array(
      z
        .object({
          id: z.string(),
          enabled: z.boolean(),
          launchSources: z
            .array(z.string())
            .describe('"golden" launches by golden name; "image" launches on a Docker host.'),
          harnesses: z.array(z.string()),
          capabilities: z.record(z.string(), z.boolean()),
          unsupportedReasons: z.record(z.string(), z.string()),
        })
        .passthrough(),
    ),
    modalRuntime: versions.optional(),
    dockerRuntime: versions.optional(),
    boatRuntime: versions,
  })
  .passthrough();

/**
 * `logs/read`: the MCP `logs` output, including the Docker `queuedPrompt`. The REST record
 * stays open: providers and later releases add fields.
 */
export const REST_LOGS_RESPONSE = z.object(LOGS_OUTPUT).passthrough();

export function responseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
}

export function requestJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
