import { SANDBOX_PROVIDERS } from "@armada/core";
import { z } from "zod";
import { LOGS_OUTPUT } from "./sandbox-tool-schemas.ts";

/** Fill missing fields from asynchronous Docker launches and pre-existing golden receipts. */
export function canonicalLaunchResponse<
  T extends {
    helper?: { status: string } | null;
    runtime?: { kind: "armada"; epoch: string } | null;
    promptId?: string | null;
    conversationId?: string | null;
  },
>(result: T) {
  return {
    ...result,
    helper: result.helper ?? null,
    runtime: result.runtime ?? null,
    promptId: result.promptId ?? null,
    conversationId: result.conversationId ?? null,
  };
}

const GOLDEN_OUTPUT = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  visibility: z.enum(["org", "private"]),
  ownerId: z.string(),
  provider: z.enum(SANDBOX_PROVIDERS).describe("The sandbox provider it runs on, fixed for its life."),
  providerSnapshotId: z.string().nullable(),
  baselineVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("The developer baseline version the golden's snapshot was verified against; null when not recorded."),
  baselineOutdated: z
    .boolean()
    .describe("True when the golden has a snapshot built against an older developer baseline than this server's."),
  providerSandboxId: z.string().nullable(),
  modal: z
    .object({ workspace: z.string(), environment: z.string(), appId: z.string() })
    .nullable()
    .describe("The Modal workspace, environment and App id a Modal golden is pinned to."),
  boatSnapshotId: z
    .string()
    .nullable()
    .describe("The same as providerSnapshotId on a Boat golden or sandbox; null on any other provider."),
  boatSandboxId: z
    .string()
    .nullable()
    .describe("The same as providerSandboxId on a Boat golden or sandbox; null on any other provider."),
  repos: z.number().int(),
  config: z.object({
    repos: z.array(z.object({ url: z.string(), branch: z.string(), dir: z.string() })),
    init: z.array(z.string()),
  }),
});

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
