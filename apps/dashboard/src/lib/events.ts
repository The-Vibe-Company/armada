import { type AgentEvent, PROMPT_STATUSES, type SandboxStatus, type ToolCall } from "@armada/core";

const ACTIVE: readonly SandboxStatus[] = ["starting", "ready", "running", "stopping"];

/** Logs of an active sandbox keep changing: the dashboard polls them. */
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

/** A message event: its `messageId` and `textMode` say how its text joins the other events of the same message. */
export type MessageEvent = Extract<AgentEvent, { kind: "message" }>;

/** The common event stream as the dashboard reads it. */
export type ChatEvent = AgentEvent;

/** The page the logs endpoint returns, from whatever the gateway sent. Events it cannot read are dropped. */
export function parseEventPage(value: unknown): { events: ChatEvent[]; cursor: string | null; hasMore: boolean } {
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEvent(value: unknown): ChatEvent | null {
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
