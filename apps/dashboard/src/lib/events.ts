import { type AgentEvent, PROMPT_STATUSES, type SandboxStatus, type ToolCall } from "@armada/core";

const ACTIVE: readonly SandboxStatus[] = ["starting", "ready", "running", "stopping"];

/** Logs of an active sandbox keep changing: the dashboard polls them. */
export function isActiveStatus(status: SandboxStatus): boolean {
  return ACTIVE.includes(status);
}

/** Appends a page to the events already shown, once each, in the order they arrived. */
export function mergeEvents(shown: readonly AgentEvent[], incoming: readonly AgentEvent[]): AgentEvent[] {
  const seen = new Set(shown.map((event) => event.id));
  const merged = [...shown];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export type EventLine = {
  id: string;
  at: number;
  label: string;
  tone: "neutral" | "success" | "danger" | "info";
  text: string;
  /** The reason a turn failed, when the event says so. */
  failure?: string;
  tools: string[];
};

export function describeEvent(event: AgentEvent): EventLine {
  const base = { id: event.id, at: event.at };
  switch (event.kind) {
    case "prompt": {
      const tone = event.status === "failed" ? "danger" : event.status === "finished" ? "success" : "info";
      return {
        ...base,
        label: `Prompt ${event.status}`,
        tone,
        text: event.text,
        ...(event.reason ? { failure: event.reason } : {}),
        tools: [],
      };
    }
    case "message":
      return {
        ...base,
        label: event.partial ? "Agent (typing)" : "Agent",
        tone: "neutral",
        text: event.text,
        tools: event.tools.map((tool) => tool.name),
      };
    case "steer":
      return { ...base, label: "Steer", tone: "info", text: event.text, tools: [] };
    case "other":
      return { ...base, label: event.type, tone: "neutral", text: "", tools: [] };
  }
}

/** The page the logs endpoint returns, from whatever the gateway sent. Events it cannot read are dropped. */
export function parseEventPage(value: unknown): { events: AgentEvent[]; cursor: string | null; hasMore: boolean } {
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

function normalizeEvent(value: unknown): AgentEvent | null {
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
      const tools = Array.isArray(value.tools)
        ? value.tools.flatMap((tool): ToolCall[] =>
            isRecord(tool) && typeof tool.id === "string" && typeof tool.name === "string"
              ? [{ id: tool.id, name: tool.name }]
              : [],
          )
        : [];
      return { ...base, kind: "message", text, partial: value.partial === true, tools };
    }
    case "steer":
      return { ...base, kind: "steer", text };
    case "other":
      return { ...base, kind: "other", type: typeof value.type === "string" ? value.type : "event", data: value.data };
    default:
      return null;
  }
}
