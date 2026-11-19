import { goldenCompatibilityIds, launchGitHubResponse, sandboxIdentity } from "@armada/core";
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

export function responseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
}

export function requestJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
