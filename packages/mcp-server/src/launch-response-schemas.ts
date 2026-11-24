import { launchGitHubResponse } from "@armada/core";
import type { LaunchEnvelope } from "@armada/core/contract";
import type { LaunchResult } from "@armada/core/server";
import { z } from "zod";

export function goldenLaunchResponse(result: LaunchResult) {
  return {
    runtime: result.runtime ?? null,
    helper: result.helper,
    sandbox: { ...result.sandbox },
    golden: { ...result.golden },
    promptId: result.promptId ?? null,
    conversationId: result.conversationId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt?.toISOString() ?? null,
    github: launchGitHubResponse(result.github),
  } satisfies LaunchEnvelope;
}

export function publicLaunchReceipt(receipt: LaunchEnvelope) {
  const { boatId: _boatId, ...sandbox } = receipt.sandbox;
  if (receipt.golden === null) return { ...receipt, sandbox };
  const { boatSnapshotId: _boatSnapshotId, boatSandboxId: _boatSandboxId, ...golden } = receipt.golden;
  return { ...receipt, sandbox, golden };
}

export function responseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
}

export function requestJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}
