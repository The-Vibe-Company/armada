import type { Harness, PromptStatus, ToolCall } from "@armada/core";
import type { ChatEvent, MessageEvent } from "./events.ts";

/** One tool call, merged from every event that carried its id (start, input, result). */
export type ToolActivity = ToolCall & { at: number };

type Turn = { conversationId?: string; promptId?: string };

/** What the conversation shows, oldest first. Each item has a stable key across polls and replays. */
export type ChatItem =
  | (Turn & { kind: "user"; key: string; at: number; text: string; status: PromptStatus; reason?: string })
  | (Turn & { kind: "steer"; key: string; at: number; text: string; mode?: string })
  | (Turn & { kind: "assistant"; key: string; at: number; text: string; streaming: boolean; model?: string })
  | (Turn & { kind: "tool"; key: string; at: number; tool: ToolActivity })
  | (Turn & { kind: "outcome"; key: string; at: number; status: "failed" | "interrupted"; reason?: string });

export type Chat = {
  items: ChatItem[];
  /** Events the conversation does not show (unknown kinds, status-only prompts), kept for the technical view. */
  technical: ChatEvent[];
  /** A turn of this view is queued or running. */
  running: boolean;
};

/**
 * How a steer reaches the running turn, as both providers declare it (`HarnessCapabilities.steer`): Claude Code joins
 * the turn, Codex interrupts it and continues with the message. Only the label depends on it; the server decides.
 */
export const STEER_RESTARTS_TURN: Readonly<Record<Harness, boolean>> = { claude: false, codex: true };

/**
 * The closed event types the server reads as a failed turn although the prompt says `finished` (`promptOutcome` in
 * `@armada/core`): the agent hit its usage limit or its credential expired. The type is the reason the turn shows.
 */
const STOP_EVENTS = new Set(["usage_limit", "auth_expiry"]);

/** Claude Code reports a tool's result under this name, with the id of the call it answers. */
const RESULT_PLACEHOLDER = "tool_result";

/**
 * The conversations a sandbox has, in the order they were opened: those Armada recorded, then any the events
 * name that the record does not know yet.
 */
export function conversationsOf(events: readonly ChatEvent[], recorded: readonly string[]): string[] {
  const ids = [...recorded];
  for (const event of events) {
    if (event.conversationId && !ids.includes(event.conversationId)) ids.push(event.conversationId);
  }
  return ids;
}

/** The events of one conversation. Events that name none belong to the sandbox and show in every view. */
export function eventsOf(events: readonly ChatEvent[], conversationId: string | null): ChatEvent[] {
  if (conversationId === null) return [...events];
  return events.filter((event) => !event.conversationId || event.conversationId === conversationId);
}

/**
 * Projects the event stream onto a conversation:
 * - one user message per prompt (`promptId`), whatever number of status events it has, with the latest status;
 * - one assistant message per `(conversationId, promptId, messageId)`: `delta` text is appended, `snapshot` text
 *   replaces it, so the streamed chunks and the final text never show twice. A message without `messageId`
 *   (legacy) stays its own message, except that streamed chunks are dropped once a final message of the same turn
 *   follows them;
 * - one tool activity per tool id, its input and result merged from later events;
 * - a failed or interrupted turn ends with its outcome; a `finished` turn with a usage-limit or expired-credential
 *   event failed, with that event's type as the reason.
 * The journal id stays the replay identity: the same events always give the same items and keys.
 */
export function projectChat(events: readonly ChatEvent[]): Chat {
  const items: ChatItem[] = [];
  const technical: ChatEvent[] = [];
  const prompts = new Map<string, Extract<ChatItem, { kind: "user" }>>();
  const messages = new Map<string, Extract<ChatItem, { kind: "assistant" }>>();
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  /** Legacy streamed chunks of each turn not yet followed by a final message. */
  const legacyChunks = new Map<string, Extract<ChatItem, { kind: "assistant" }>[]>();
  const superseded = new Set<string>();
  /** The first stop event type of each turn that has one, by `promptId`, as the server reads it. */
  const stops = new Map<string, string>();

  for (const event of events) {
    const turn: Turn = {
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      ...(event.promptId ? { promptId: event.promptId } : {}),
    };
    const turnKey = `${event.conversationId ?? ""}\u0000${event.promptId ?? ""}`;
    switch (event.kind) {
      case "prompt": {
        const key = event.promptId ? `prompt:${event.promptId}` : `event:${event.id}`;
        const known = prompts.get(key);
        if (known) {
          known.status = event.status;
          if (!known.conversationId && event.conversationId) known.conversationId = event.conversationId;
          if (!known.text && event.text) known.text = event.text;
          if (event.reason) known.reason = event.reason;
          else if (event.status !== "failed") delete known.reason;
        } else if (event.text || event.promptId) {
          const item = {
            ...turn,
            kind: "user" as const,
            key,
            at: event.at,
            text: event.text,
            status: event.status,
            ...(event.reason ? { reason: event.reason } : {}),
          };
          prompts.set(key, item);
          items.push(item);
        } else technical.push(event);
        break;
      }
      case "steer":
        items.push({
          ...turn,
          kind: "steer",
          key: `event:${event.id}`,
          at: event.at,
          text: event.text,
          ...(event.mode ? { mode: event.mode } : {}),
        });
        break;
      case "message":
        addMessage(event, turn, turnKey);
        for (const call of event.tools) addTool(call, event, turn);
        break;
      case "other":
        if (event.promptId && STOP_EVENTS.has(event.type) && !stops.has(event.promptId)) {
          stops.set(event.promptId, event.type);
        }
        technical.push(event);
        break;
    }
  }

  function addMessage(event: MessageEvent, turn: Turn, turnKey: string) {
    if (event.messageId) {
      const key = `message:${event.conversationId ?? ""}:${event.promptId ?? ""}:${event.messageId}`;
      const known = messages.get(key);
      const mode = event.textMode ?? "snapshot";
      if (known) {
        known.text = mode === "delta" ? known.text + event.text : event.text;
        known.streaming = event.partial;
        if (event.model) known.model = event.model;
        return;
      }
      const item = {
        ...turn,
        kind: "assistant" as const,
        key,
        at: event.at,
        text: event.text,
        streaming: event.partial,
        ...(event.model ? { model: event.model } : {}),
      };
      messages.set(key, item);
      items.push(item);
      return;
    }
    if (!event.text) return;
    const item = {
      ...turn,
      kind: "assistant" as const,
      key: `event:${event.id}`,
      at: event.at,
      text: event.text,
      streaming: event.partial,
      ...(event.model ? { model: event.model } : {}),
    };
    if (event.partial) {
      legacyChunks.set(turnKey, [...(legacyChunks.get(turnKey) ?? []), item]);
    } else {
      for (const chunk of legacyChunks.get(turnKey) ?? []) superseded.add(chunk.key);
      legacyChunks.delete(turnKey);
    }
    items.push(item);
  }

  function addTool(call: ToolCall, event: ChatEvent, turn: Turn) {
    const key = `tool:${call.id}`;
    const known = tools.get(key);
    if (!known) {
      const item = { ...turn, kind: "tool" as const, key, at: event.at, tool: { ...call, at: event.at } };
      tools.set(key, item);
      items.push(item);
      return;
    }
    const tool = known.tool;
    if (tool.name === RESULT_PLACEHOLDER && call.name !== RESULT_PLACEHOLDER) tool.name = call.name;
    if (call.input !== undefined) tool.input = call.input;
    if (call.result !== undefined) tool.result = call.result;
  }

  for (const prompt of prompts.values()) {
    const stop = prompt.promptId ? stops.get(prompt.promptId) : undefined;
    if (stop && prompt.status === "finished") {
      prompt.status = "failed";
      prompt.reason = stop;
    }
  }

  const shown = items.filter(
    (item) => !superseded.has(item.key) && !(item.kind === "assistant" && item.text === "" && !item.streaming),
  );
  const withOutcomes: ChatItem[] = [];
  const lastOfTurn = new Map<string, number>();
  shown.forEach((item, index) => {
    if (item.promptId) lastOfTurn.set(item.promptId, index);
  });
  const outcomes = new Map<number, ChatItem[]>();
  for (const prompt of prompts.values()) {
    if (prompt.status !== "failed" && prompt.status !== "interrupted") continue;
    const index = (prompt.promptId ? lastOfTurn.get(prompt.promptId) : undefined) ?? shown.indexOf(prompt);
    const outcome: ChatItem = {
      ...(prompt.conversationId ? { conversationId: prompt.conversationId } : {}),
      ...(prompt.promptId ? { promptId: prompt.promptId } : {}),
      kind: "outcome",
      key: `outcome:${prompt.key}`,
      at: prompt.at,
      status: prompt.status,
      ...(prompt.reason ? { reason: prompt.reason } : {}),
    };
    outcomes.set(index, [...(outcomes.get(index) ?? []), outcome]);
  }
  shown.forEach((item, index) => {
    withOutcomes.push(item);
    withOutcomes.push(...(outcomes.get(index) ?? []));
  });

  const running = [...prompts.values()].some((prompt) => prompt.status === "queued" || prompt.status === "running");
  return { items: withOutcomes, technical, running };
}

/** The few words that say what a tool call is about: its command, path, pattern or query. */
export function toolSummary(input: unknown): string {
  if (typeof input === "string") return oneLine(input);
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const field of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return oneLine(value);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return oneLine(value.join(" "));
  }
  return "";
}

/** A tool's input or result as text: strings as they are, text blocks joined, anything else as indented JSON. */
export function toolText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(isTextBlock)) return value.map((block) => block.text).join("\n");
  if (isTextBlock(value)) return value.text;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "text" &&
    typeof (value as Record<string, unknown>).text === "string"
  );
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
