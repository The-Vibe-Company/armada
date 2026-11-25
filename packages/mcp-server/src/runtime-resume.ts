import { HARNESS_CAPABILITIES } from "@armada/core";
import { type PromptReceipt, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import type { createResumeJob } from "./jobs/resume.ts";
import type { JobContext } from "./jobs/runner.ts";
import { runtimeBridgeTarget } from "./provider-runtime-admission.ts";
import { historicalRuntimeResumeReceipt } from "./runtime-resume-receipts.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";

export interface RuntimeResumeInput {
  id: string;
  request_id: string;
  runtimeVersion: 1;
  prompt: string;
}
/** Shared runner authority for an exact queued send. */
export type RuntimeTurnClaim = Pick<JobContext, "canDispatch" | "handoffGeneration">;

export interface RuntimeResumeReceipt {
  id: string;
  requestId: string;
  promptId: string;
  conversationId: string;
  status: PromptReceipt["status"];
  resumed: true;
  runtime: { kind: "armada"; epoch: string };
  sourceCheckpoint: { epoch: string; watermark: number; empty?: true };
}
export type RuntimeResume = ReturnType<typeof createRuntimeResume>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export function createRuntimeResume(sql: Sql, resume: ReturnType<typeof createResumeJob>["resume"]) {
  return async (caller: Caller, input: RuntimeResumeInput): Promise<RuntimeResumeReceipt> => {
    refuseConversationSelector(input);
    const requestId = input.request_id.toLowerCase();
    if (input.runtimeVersion !== 1 || !uuid.test(input.id) || !uuid.test(requestId) || !input.prompt.trim())
      throw new VaultError("invalid", "Runtime resume v1 requires UUIDs and a nonempty instruction.");
    const found = await createSqlData(sql)(caller).sandboxes.get(input.id);
    if (!found || found.ownerId !== caller.userId || !runtimeBridgeTarget(found) || found.deletedAt)
      throw new VaultError("not_found", "No owned runtime resume target.");
    if (!HARNESS_CAPABILITIES[found.harness].resume)
      throw new VaultError("unavailable", "This harness cannot resume a stopped conversation.");
    const historical = await historicalRuntimeResumeReceipt(sql, caller, {
      id: found.id,
      requestId,
      prompt: input.prompt,
    });
    return historical ?? resume(caller, found, { ...input, id: found.id, request_id: requestId });
  };
}
