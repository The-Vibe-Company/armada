import { goldenCompatibilityIds, launchGitHubResponse, SANDBOX_PROVIDERS, sandboxIdentity } from "@armada/core";
import type { LaunchEnvelope } from "@armada/core/contract";
import type { LaunchResult } from "@armada/core/server";
import { z } from "zod";

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

export function goldenLaunchResponse(result: LaunchResult) {
  return {
    runtime: result.runtime ?? null,
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
  } satisfies LaunchEnvelope;
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

export function responseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
}

export function requestJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
