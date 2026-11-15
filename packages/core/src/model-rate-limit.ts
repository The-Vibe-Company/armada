import { dedupeEvents } from "./outcome.ts";
import type { AgentEvent } from "./provider.ts";

export interface ModelRateLimit {
  retryCount: number;
  delayMs: number;
  totalWaitMs: number;
  retryAt: number;
  waiting: boolean;
  message: string;
}

/** Only structured runtime evidence is trusted; prose and provider errors are not status. */
export function modelRateLimit(
  events: readonly AgentEvent[],
  promptId: string,
  now: number,
  running = true,
): ModelRateLimit | null {
  const turn = dedupeEvents(events).filter((event) => event.promptId === promptId);
  for (let i = turn.length - 1; i >= 0; i--) {
    const event = turn[i];
    if (!event || event.kind !== "other" || event.type !== "armada/modelRateLimit") continue;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    const { retryCount, delayMs, totalWaitMs, reason } = data as Record<string, unknown>;
    const genericRetry = reason === "model_provider_retry";
    if (
      ![retryCount, delayMs, totalWaitMs].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      continue;
    const retryAt = event.at + (delayMs as number);
    const waiting =
      running &&
      retryAt > now &&
      !turn
        .slice(i + 1)
        .some((next) => next.kind === "message" || (next.kind === "prompt" && next.status !== "running"));
    return {
      retryCount: retryCount as number,
      delayMs: delayMs as number,
      totalWaitMs: totalWaitMs as number,
      retryAt,
      waiting,
      message: waiting
        ? genericRetry
          ? `Model provider request retrying in ${Math.ceil((retryAt - now) / 1000)} s`
          : `Rate limited by the model provider, retrying in ${Math.ceil((retryAt - now) / 1000)} s`
        : genericRetry
          ? "Model provider retry wait completed"
          : "Model provider rate-limit wait completed",
    };
  }
  return null;
}
