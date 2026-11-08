import { type AgentEvent, PROMPT_STATUSES, type PromptStatus, type ToolCall } from "@armada/core";
import type { SandboxEvent } from "@boatdev/sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** boat's `sending` is a prompt not yet queued: for a caller it is still waiting. */
export function promptStatus(value: unknown): PromptStatus | undefined {
  if (value === "sending") return "queued";
  return (PROMPT_STATUSES as readonly unknown[]).includes(value) ? (value as PromptStatus) : undefined;
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.use)) continue;
    const id = str(entry.use.id);
    const name = str(entry.use.name);
    if (!id || !name) continue;
    const call: ToolCall = { id, name };
    if (entry.use.input !== undefined) call.input = entry.use.input;
    if (isRecord(entry.result)) call.result = { output: entry.result.content, isError: entry.result.is_error === true };
    calls.push(call);
  }
  return calls;
}

/**
 * The opaque cursor boat documents: base64url, no padding, of `<timestamp>:<id>` of the last event read.
 * An event without both cannot anchor a cursor.
 */
export function eventCursor(event: Pick<SandboxEvent, "id" | "timestamp">): string | undefined {
  if (event.id === undefined || event.timestamp === undefined) return undefined;
  return Buffer.from(`${event.timestamp}:${event.id}`).toString("base64url");
}

/**
 * Maps one boat event onto the common stream. It never throws: what it does not recognise stays whole as `other`.
 *
 * boat documents `prompt` (`data.prompt`, `data.status`), `response` (`data.content`, `data.is_streaming`,
 * `data.tools`) and `steer` events; the fields of a steer event and the reason of a failed prompt are not
 * documented, so they are read from the likeliest names and left empty when absent.
 */
export function normalizeEvent(event: SandboxEvent): AgentEvent {
  const at = event.timestamp ?? 0;
  const data: Record<string, unknown> = isRecord(event.data) ? event.data : {};
  const base = {
    id: event.id ?? `${at}`,
    at,
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.taskId ? { promptId: event.taskId } : {}),
  };
  switch (event.type) {
    case "prompt": {
      const status = promptStatus(data.status);
      if (status === undefined) break;
      const reason = str(data.error) ?? str(data.reason);
      return { ...base, kind: "prompt", text: str(data.prompt) ?? "", status, ...(reason ? { reason } : {}) };
    }
    case "response": {
      const model = str(data.model);
      return {
        ...base,
        kind: "message",
        text: typeof data.content === "string" ? data.content : "",
        partial: data.is_streaming === true,
        ...(model ? { model } : {}),
        tools: toolCalls(data.tools),
      };
    }
    case "steer": {
      const mode = str(data.mode);
      return {
        ...base,
        kind: "steer",
        text: str(data.message) ?? str(data.text) ?? str(data.prompt) ?? "",
        ...(mode ? { mode } : {}),
      };
    }
  }
  return { ...base, kind: "other", type: event.type, data: event.data ?? {} };
}
