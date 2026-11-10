import type { AgentEvent, Provider } from "./provider.ts";

/** Event types boat sends when a turn ends "finished" but the agent could not work. */
const FAILURE_EVENTS = new Set(["usage_limit", "auth_expiry"]);

const OUTCOME_PAGE_LIMIT = 200;
const OUTCOME_PAGES = 50;

export type PromptOutcome =
  | { state: "running" }
  | { state: "finished" }
  | { state: "interrupted"; reason?: "interrupted_by_provider_move" | "interrupted_by_harness_exit" }
  | { state: "failed"; reason: string };

/** Closed, resendable turn interruptions. Boat's raw failed events and normalized events share this mapping. */
export function turnInterruptionReason(
  message: string | undefined,
): "interrupted_by_provider_move" | "interrupted_by_harness_exit" | undefined {
  if (
    message === "interrupted_by_provider_move" ||
    message === "The box moved to a new machine while this prompt was running. Send it again."
  )
    return "interrupted_by_provider_move";
  if (
    message === "interrupted_by_harness_exit" ||
    (message && /^Codex app-server exited with signal .+; the next prompt starts a fresh process[.]?$/.test(message))
  )
    return "interrupted_by_harness_exit";
  return undefined;
}

/**
 * Events that were read again carry the same id and a newer body: a streaming answer is rewritten
 * in place. The last body of each id wins and the order of first sight is kept.
 */
export function dedupeEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

/**
 * How one prompt ended. The status comes from `getPrompt`, not from the events, because a prompt
 * event is updated in place. A turn that boat reports `finished` is a failure when the agent hit its
 * usage limit or its login expired: boat still calls that finished.
 */
export async function promptOutcome(
  provider: Provider,
  request: { sandboxId: string; promptId: string; conversationId?: string },
): Promise<PromptOutcome> {
  const state = await provider.getPrompt({ sandboxId: request.sandboxId, promptId: request.promptId });
  if (state.status === "interrupted" || state.status === "failed") {
    const reason = (await promptEvents(provider, request)).find((event) => event.kind === "prompt" && event.reason);
    const message = reason?.kind === "prompt" ? reason.reason : undefined;
    const interruption = turnInterruptionReason(message);
    if (interruption) return { state: "interrupted", reason: interruption };
    if (state.status === "interrupted") return { state: "interrupted" };
    return {
      state: "failed",
      reason: reason?.kind === "prompt" && reason.reason ? reason.reason : "The agent failed.",
    };
  }
  if (state.status !== "finished") return { state: "running" };
  const stop = (await promptEvents(provider, request)).find(
    (event) => event.kind === "other" && FAILURE_EVENTS.has(event.type),
  );
  if (stop?.kind === "other") return { state: "failed", reason: failureReason(stop.type, stop.data) };
  return { state: "finished" };
}

/** Bounded newest-first read stopping at this prompt's own start, not sandbox creation. */
export async function readPromptEvents(
  provider: Provider,
  request: { sandboxId: string; promptId: string; conversationId?: string },
): Promise<{ events: AgentEvent[]; complete: boolean }> {
  const all: AgentEvent[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < OUTCOME_PAGES; page++) {
    const read = await provider.events({
      sandboxId: request.sandboxId,
      direction: "backward",
      ...(cursor ? { cursor } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      limit: OUTCOME_PAGE_LIMIT,
    });
    all.unshift(...read.events);
    const foundStart = read.events.some(
      (event) =>
        event.kind === "prompt" &&
        event.promptId === request.promptId &&
        (provider.id === "boat" || event.status === "queued" || event.status === "running"),
    );
    if (foundStart || !read.hasMore)
      return {
        events: dedupeEvents(all).filter((event) => event.promptId === request.promptId || !event.promptId),
        complete: foundStart,
      };
    const next = read.olderCursor;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return {
    events: dedupeEvents(all).filter((event) => event.promptId === request.promptId || !event.promptId),
    complete: false,
  };
}

async function promptEvents(
  provider: Provider,
  request: { sandboxId: string; promptId: string; conversationId?: string },
): Promise<AgentEvent[]> {
  try {
    return (await readPromptEvents(provider, request)).events.filter((event) => event.promptId === request.promptId);
  } catch {
    return [];
  } // Optional event evidence must not turn a provider-finished turn into a transport failure.
}

function failureReason(type: string, data: unknown): string {
  const fallback = type === "usage_limit" ? "The agent hit its usage limit." : "The agent's login expired.";
  if (typeof data !== "object" || data === null) return fallback;
  const record = data as Record<string, unknown>;
  for (const key of ["message", "error", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}
