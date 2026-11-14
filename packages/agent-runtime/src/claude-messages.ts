import type { SDKAssistantMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk/core";
import type { DriverContext } from "./protocol.ts";

/** Accumulate per-query Claude content frames without mixing interleaved subagent streams. */
export class ClaudeMessages {
  private readonly messages = new Map<string | null, string>();
  private readonly completedText = new Map<string, string>();
  private readonly completedFrames = new Set<string>();

  constructor(private readonly emit: DriverContext["emit"]) {}

  stream(event: SDKPartialAssistantMessage): void {
    const e = event.event;
    const parent = event.parent_tool_use_id ?? null;
    if (e.type === "message_start") this.messages.set(parent, e.message.id);
    const messageId = this.messages.get(parent);
    if (e.type === "message_stop") this.messages.delete(parent);
    if (e.type === "content_block_start" && e.content_block.type === "tool_use")
      this.emit({
        kind: "message",
        text: "",
        partial: true,
        tools: [{ id: e.content_block.id, name: e.content_block.name, input: e.content_block.input }],
      });
    if (e.type === "content_block_delta" && e.delta.type === "text_delta")
      this.emit({
        kind: "message",
        text: e.delta.text,
        partial: true,
        tools: [],
        ...(messageId ? { messageId, textMode: "delta" as const } : {}),
      });
  }

  complete(event: SDKAssistantMessage): void {
    const tools = event.message.content.flatMap((block) =>
      block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
    );
    // The pinned CLI emits one assistant frame per completed content block,
    // not a full message snapshot. Tool/thinking blocks must not erase text.
    const key = JSON.stringify([event.parent_tool_use_id, event.message.id]);
    if (!this.completedFrames.has(event.uuid)) {
      this.completedFrames.add(event.uuid);
      this.completedText.set(
        key,
        (this.completedText.get(key) ?? "") +
          event.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      );
    }
    this.emit({
      kind: "message",
      messageId: event.message.id,
      textMode: "snapshot",
      text: this.completedText.get(key) ?? "",
      partial: false,
      model: event.message.model,
      responseKind: "assistant",
      ...(event.parent_tool_use_id ? { parentToolUseId: event.parent_tool_use_id } : {}),
      tools,
    });
  }
}
