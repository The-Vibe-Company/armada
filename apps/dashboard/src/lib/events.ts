import { type AgentEvent, isRecord, PROMPT_STATUSES, type SandboxStatus, type ToolCall } from "@armada/core";
import { SANDBOX_STATUSES } from "@armada/core/contract";
import { sandboxUsesRuntime } from "./sandbox-thread";

const ACTIVE: readonly SandboxStatus[] = ["starting", "ready", "running", "stopping"];
const DECIMAL_SEQUENCE = /^(0|[1-9][0-9]*)$/;

export function isSandboxStatus(value: unknown): value is SandboxStatus {
  return typeof value === "string" && (SANDBOX_STATUSES as readonly string[]).includes(value);
}

export function isSuccessfulPage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isSandboxStatus(value.status)) return false;
  if (value.usageRevision !== undefined && typeof value.usageRevision !== "string") return false;
  if (value.configured !== undefined && typeof value.configured !== "boolean") return false;
  if (!Array.isArray(value.events)) return false;
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== "string") return false;
  if (typeof value.hasMore !== "boolean") return false;
  if ("error" in value) return false;
  return value.prompt === undefined || value.prompt === null || isRecord(value.prompt);
}

/** Logs of an active sandbox keep changing. */
export function isActiveStatus(status: SandboxStatus): boolean {
  return ACTIVE.includes(status);
}

/**
 * Adds a page to the events already shown, in the order they first arrived. An event read again (same journal id)
 * keeps its place and takes the newer body, as the `logs` tool promises.
 */
export function mergeEvents(shown: readonly ChatEvent[], incoming: readonly ChatEvent[]): ChatEvent[] {
  const index = new Map(shown.map((event, position) => [event.id, position]));
  const merged = [...shown];
  for (const event of incoming) {
    const position = index.get(event.id);
    if (position === undefined) {
      index.set(event.id, merged.length);
      merged.push(event);
    } else merged[position] = event;
  }
  return merged;
}

export const initialChatHistory = {
  events: [] as ChatEvent[],
  cursor: null as string | null,
  olderCursor: null as string | null,
  loaded: false,
};

export type ChatHistory = typeof initialChatHistory;

const RUNTIME_CURSOR = /^(ar1_[0-9a-f-]+_)(0|[1-9][0-9]*)$/i;

function newerRuntimeCursor(current: string | null, incoming: string | null) {
  if (!incoming) return current;
  if (!current) return incoming;
  const a = RUNTIME_CURSOR.exec(current);
  const b = RUNTIME_CURSOR.exec(incoming);
  if (a && b && a[1] === b[1]) {
    return BigInt(b[2]!) >= BigInt(a[2]!) ? incoming : current;
  }
  return incoming;
}

function runtimeCursorSequence(cursor: string | null, sandboxId: string) {
  const prefix = `ar1_${sandboxId}_`;
  if (!cursor?.startsWith(prefix)) return null;
  const suffix = cursor.slice(prefix.length);
  return DECIMAL_SEQUENCE.test(suffix) ? BigInt(suffix) : null;
}

export function applyInlineEvent(history: ChatHistory, sandboxId: string, event: ChatEvent, sequence: string | null) {
  const seq = sequence !== null && DECIMAL_SEQUENCE.test(sequence) ? BigInt(sequence) : null;
  const historySeq = runtimeCursorSequence(history.cursor, sandboxId);
  if (historySeq !== null && seq !== null && seq <= historySeq) {
    return history;
  }
  const events = mergeEvents(history.events, [event]);
  const cursor =
    historySeq !== null && seq !== null && seq === historySeq + 1n ? `ar1_${sandboxId}_${sequence}` : history.cursor;
  return { ...history, events, cursor } satisfies ChatHistory;
}

export function applyChatPage(
  history: typeof initialChatHistory,
  page: ReturnType<typeof parseEventPage>,
  direction: "forward" | "latest" | "older",
) {
  const older = direction === "older";
  const previous = older ? history.olderCursor : history.cursor;
  const next = older ? page.olderCursor : page.cursor;
  if (page.hasMore && (!next || next === previous)) return null;

  let events = history.events;
  if (page.events.length) {
    events = older ? mergeEvents(page.events, events) : mergeEvents(events, page.events);
  }
  return {
    events,
    cursor: older ? history.cursor : newerRuntimeCursor(history.cursor, page.cursor),
    olderCursor: direction === "forward" ? history.olderCursor : page.hasMore ? (page.olderCursor ?? null) : null,
    loaded: true,
  } satisfies typeof initialChatHistory;
}

/** A message event: its `messageId` and `textMode` say how its text joins the other events of the same message. */
export type MessageEvent = Extract<AgentEvent, { kind: "message" }>;

/** The common event stream as the dashboard reads it. */
export type ChatEvent = AgentEvent;

/** The page the logs endpoint returns, from whatever the gateway sent. Events it cannot read are dropped. */
export function parseEventPage(value: unknown): {
  events: ChatEvent[];
  cursor: string | null;
  hasMore: boolean;
  olderCursor?: string;
} {
  const record = isRecord(value) ? value : {};
  const rawEvents = Array.isArray(record.events) ? record.events : [];
  const events = rawEvents.flatMap((raw) => {
    const event = normalizeEvent(raw);
    return event ? [event] : [];
  });
  return {
    events,
    cursor: typeof record.cursor === "string" ? record.cursor : null,
    hasMore: record.hasMore === true,
    ...(typeof record.olderCursor === "string" ? { olderCursor: record.olderCursor } : {}),
  };
}

export function normalizeEvent(value: unknown): ChatEvent | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.at !== "number") return null;
  const base = {
    id: value.id,
    at: value.at,
    ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
    ...(typeof value.promptId === "string" ? { promptId: value.promptId } : {}),
  };
  const text = typeof value.text === "string" ? value.text : "";
  switch (value.kind) {
    case "prompt": {
      const status = PROMPT_STATUSES.find((candidate) => candidate === value.status);
      if (!status) return null;
      return {
        ...base,
        kind: "prompt",
        text,
        status,
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      };
    }
    case "message": {
      const tools = Array.isArray(value.tools) ? value.tools.flatMap(normalizeTool) : [];
      return {
        ...base,
        kind: "message",
        text,
        partial: value.partial === true,
        ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
        ...(typeof value.messageId === "string" && value.messageId ? { messageId: value.messageId } : {}),
        ...(value.textMode === "delta" || value.textMode === "snapshot" ? { textMode: value.textMode } : {}),
        tools,
      };
    }
    case "steer":
      return {
        ...base,
        kind: "steer",
        text,
        ...(typeof value.mode === "string" && value.mode ? { mode: value.mode } : {}),
      };
    case "other":
      return { ...base, kind: "other", type: typeof value.type === "string" ? value.type : "event", data: value.data };
    default:
      return null;
  }
}

function normalizeTool(tool: unknown): ToolCall[] {
  if (!isRecord(tool) || typeof tool.id !== "string" || typeof tool.name !== "string") return [];
  const call: ToolCall = { id: tool.id, name: tool.name };
  if (tool.input !== undefined) call.input = tool.input;
  if (isRecord(tool.result)) call.result = { output: tool.result.output, isError: tool.result.isError === true };
  return [call];
}

export function conversationReadDirection(
  sandbox: { provider: string | null; runtime_transport: string | null; boat_runtime: boolean },
  source: "history" | "follow",
) {
  return source === "history" && sandboxUsesRuntime(sandbox) ? "backward" : "forward";
}

/** One upstream page after `initialCursor`; the caller follows historical continuations. */
export async function readLogPages(
  logs: (id: string, cursor?: string | null) => Promise<unknown>,
  id: string,
  initialCursor: string | null,
) {
  const page = parseEventPage(await logs(id, initialCursor));
  if (page.hasMore && (!page.cursor?.trim() || page.cursor === initialCursor)) {
    throw new Error("The logs continuation requires an advancing cursor.");
  }
  return { ...page, cursor: page.cursor ?? initialCursor };
}
