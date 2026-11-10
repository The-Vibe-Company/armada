import { type AgentEvent, type EventPage, type EventsRequest, ProviderError } from "./provider.ts";

type ReadOptions = Pick<EventsRequest, "cursor" | "direction" | "limit" | "maxBytes" | "coalesce">;

export function eventPageOptions(request: ReadOptions, provider: string) {
  const limit = request.limit ?? 100;
  const maxBytes = request.maxBytes ?? 262144;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 256 ||
    maxBytes > 1048576 ||
    (request.direction !== undefined && request.direction !== "forward" && request.direction !== "backward") ||
    (request.coalesce !== undefined && typeof request.coalesce !== "boolean")
  )
    throw new ProviderError({
      provider,
      code: "invalid_request",
      message: "Invalid event pagination.",
      retryable: false,
    });
  return { limit, maxBytes, backward: request.direction === "backward" };
}

/** Missing logical identity is deliberately not guessed from turn IDs or adjacency. */
export function coalesceEventMessages(events: AgentEvent[]): AgentEvent[] {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (
      event.kind === "message" &&
      previous?.kind === "message" &&
      event.messageId &&
      event.messageId === previous.messageId &&
      event.conversationId === previous.conversationId &&
      event.promptId === previous.promptId &&
      event.textMode &&
      previous.textMode === "snapshot"
    ) {
      const tools = new Map(previous.tools.map((tool) => [tool.id, tool]));
      for (const tool of event.tools) tools.set(tool.id, tool);
      result[result.length - 1] = {
        ...event,
        text: event.textMode === "snapshot" ? event.text : previous.text + event.text,
        textMode: "snapshot",
        tools: [...tools.values()],
      };
    } else result.push(event);
  }
  return result;
}

/** Entries follow traversal order; emitted events follow chronological order. Cursors always anchor raw entries. */
export function boundEventEntries<T>(
  entries: { cursor: string; event: T }[],
  request: ReadOptions,
  upstreamHasMore: boolean,
  provider: string,
  coalescer?: (events: T[]) => T[],
  truncate?: (event: T, originalBytes: number) => T,
): { events: T[]; cursor?: string; olderCursor?: string; hasMore: boolean } {
  const { limit, maxBytes, backward } = eventPageOptions(request, provider);
  const selected: typeof entries = [];
  let events: T[] = [];
  let bytes = 2;
  const encoder = new TextEncoder();
  for (const entry of entries.slice(0, limit)) {
    const coalescing = request.coalesce && coalescer;
    let candidateEvents: T[] = [];
    let candidateBytes: number;
    if (coalescing) {
      const candidate = [...selected, entry];
      candidateEvents = coalescer((backward ? candidate.toReversed() : candidate).map((item) => item.event));
      candidateBytes = encoder.encode(JSON.stringify(candidateEvents)).length;
    } else {
      candidateBytes = bytes + (selected.length ? 1 : 0) + encoder.encode(JSON.stringify(entry.event)).length;
    }
    if (candidateBytes > maxBytes) {
      if (!selected.length) {
        const originalBytes = encoder.encode(JSON.stringify([entry.event])).length;
        // The soft page budget must never make a raw cursor unreadable.
        events = [originalBytes > 1048576 && truncate ? truncate(entry.event, originalBytes) : entry.event];
        selected.push(entry);
      }
      break;
    }
    selected.push(entry);
    bytes = candidateBytes;
    if (coalescing) events = candidateEvents;
    else if (backward) events.unshift(entry.event);
    else events.push(entry.event);
  }
  const oldest = backward ? selected.at(-1) : selected[0];
  const newest = backward ? selected[0] : selected.at(-1);
  const cursor = newest?.cursor ?? request.cursor;
  return {
    events,
    ...(cursor ? { cursor } : {}),
    ...(backward && oldest ? { olderCursor: oldest.cursor } : {}),
    hasMore: upstreamHasMore || selected.length < entries.length,
  };
}

export function buildEventPage(
  entries: { cursor: string; event: AgentEvent }[],
  request: ReadOptions,
  upstreamHasMore: boolean,
  provider: string,
): EventPage {
  return boundEventEntries(entries, request, upstreamHasMore, provider, coalesceEventMessages, truncateEvent);
}

/** Closed replacement for an indivisible event above the hard history limit. */
export function truncateEvent(event: AgentEvent, originalBytes: number, originalKind: string = event.kind): AgentEvent {
  return {
    id: event.id.slice(0, 256),
    at: event.at,
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.promptId ? { promptId: event.promptId } : {}),
    kind: "other",
    type: "event_truncated",
    data: { reason: "event_exceeds_hard_limit", originalKind, originalBytes, limitBytes: 1048576 },
  };
}
