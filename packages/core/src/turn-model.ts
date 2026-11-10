import { dedupeEvents } from "./outcome.ts";
import type { AgentEvent } from "./provider.ts";

export type ModelSelectionReason = "model_selection_mismatch" | "model_selection_unverified";

export interface TurnModelEvidence {
  requestedModel: string | null;
  observedModel: string | null;
  modelSelectionReason: ModelSelectionReason | null;
  modelSelectionMessage: string | null;
}

/**
 * Response metadata, not assistant prose or the provider's requested-model echo, is evidence.
 * Read the whole prompt history before claiming a match. In-place rewrites/retractions win;
 * nested-agent and streaming responses do not establish the main thread's model.
 * Alias expansion is deliberately not guessed: provider aliases can change over time.
 */
export function turnModelEvidence(
  events: readonly AgentEvent[],
  request: { promptId: string; requestedModel: string | null; complete: boolean },
): TurnModelEvidence {
  const responses = dedupeEvents(events).filter(
    (event) =>
      event.promptId === request.promptId &&
      event.kind === "message" &&
      !event.partial &&
      event.responseKind !== "tool_result" &&
      !event.parentToolUseId &&
      !event.retracted,
  );
  const models = new Set(responses.flatMap((event) => (event.kind === "message" && event.model ? [event.model] : [])));
  const observedModel = models.size === 1 ? ([...models][0] ?? null) : null;
  const mismatch = request.requestedModel !== null && [...models].some((model) => model !== request.requestedModel);
  const verified =
    request.complete &&
    request.requestedModel !== null &&
    responses.length > 0 &&
    responses.every((event) => event.kind === "message" && event.model === request.requestedModel);
  const modelSelectionReason = mismatch ? "model_selection_mismatch" : verified ? null : "model_selection_unverified";
  return {
    requestedModel: request.requestedModel,
    observedModel,
    modelSelectionReason,
    modelSelectionMessage:
      modelSelectionReason === null
        ? null
        : `${mismatch ? "The observed response model differs from the requested model." : "The requested model could not be verified from complete response evidence."} Work may already have occurred. Do not retry automatically.`,
  };
}
