// A project's room (THE-1996): the owner's conversation with the project's
// coordinator, read through pi-durable's public conversation API (never its
// storage writes) and the log's `coordinator.message` events; a message sent
// as pi input with the app's `requestId`; the owner's answer to a question
// pinned in the room. Each request answers one message; nothing here writes
// but `chat.send` (the coordinator's checkpoint) and `owner.answer`.
import {
  type ChatItem,
  type ChatReadRequest,
  type ChatSendRequest,
  type OwnerAnswerRequest,
  type ServerMessage,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ProjectCoordinator } from "../../coordinator/index.ts";
import type { Json } from "../events.ts";
import { fold } from "../fold.ts";
import type { EventStore } from "../store.ts";

/** At most this many items of a long conversation: its latest. */
export const CHAT_LIMIT = 200;
/** A tool's result past this many characters is cut: the room shows a reading, not a dump. */
const OUTPUT_LIMIT = 8 * 1024;
/** The input entry the owner's answer to a pinned question is placed as (reserved: entry-kind). */
export const OWNER_ANSWER_ENTRY = "armada.owner-answer";

export type ChatRequest = ChatReadRequest | ChatSendRequest | OwnerAnswerRequest;
export interface ChatOptions {
  store: EventStore;
  /** The project's coordinator, when one runs. */
  coordinator: ProjectCoordinator | undefined;
  now?: () => number;
}

const NO_COORDINATOR = "No coordinator runs for this project: save its model key, then restart the daemon";

/** Answers one of the room's requests; a failure is one line, never the backend's. */
export async function dispatchChat(request: ChatRequest, options: ChatOptions): Promise<ServerMessage> {
  const { id, project } = request;
  const error = (code: "not-found" | "internal", message: string): ServerMessage => ({
    type: "error",
    version,
    id,
    code,
    message,
  });
  try {
    switch (request.type) {
      case "chat.read": {
        const seq = options.store.sequence;
        const items = await readChat(options.store, project, options.coordinator);
        return { type: "chat.result", version, id, project, seq, coordinator: !!options.coordinator, items };
      }
      case "chat.send": {
        if (!options.coordinator) return error("not-found", NO_COORDINATOR);
        // The same requestId again (a retry after a drop) is the same input: pi admits it once.
        await options.coordinator.conversation.submit(
          { type: "input", content: request.body, requestId: request.requestId },
          context,
        );
        return { type: "chat.sent", version, id, project, requestId: request.requestId };
      }
      case "owner.answer":
        return answerOwner(request, options) ?? error("not-found", "No such question waits for you");
    }
  } catch {
    return error("internal", request.type === "chat.read" ? "Could not read the conversation" : "Could not send it");
  }
}

/**
 * Records the owner's answer to an open `owner-request` (the fold and the
 * append run without a wait between them: two answers cannot both land), then
 * tells the coordinator, which delivers it to the worker. The coordinator's
 * input is keyed by the item, so a repeated answer is one input.
 */
function answerOwner(request: OwnerAnswerRequest, options: ChatOptions): ServerMessage | null {
  const { store, project, item } = { ...options, ...request };
  const open = fold(store.readSince(0, project)).projects[project]?.inbox.find(
    (i) => i.id === item && i.kind === "owner-request",
  );
  if (!open) return null;
  const note = request.note?.trim() || null;
  store.append({
    project,
    kind: "inbox.answered",
    at: new Date((options.now ?? Date.now)()).toISOString(),
    actor: "owner",
    payload: { id: item, answer: note ? `${request.choice}\n\nNote: ${note}` : request.choice },
  });
  if (options.coordinator)
    void options.coordinator.conversation
      .submit(
        {
          type: "input",
          content: `The owner answered ${open.ticket}'s question: ${request.choice}${note ? `\nNote: ${note}` : ""}`,
          requestId: `owner-answer:${item}`,
          entry: { kind: OWNER_ANSWER_ENTRY, data: { ticket: open.ticket, choice: request.choice, note } },
        },
        context,
      )
      // The answer is recorded; the coordinator reads the inbox on its next turn either way.
      .catch(() => {});
  return { type: "owner.answered", version, id: request.id, project, item };
}

type Message = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
      : "";

/** The facts' own word: a tool that answered `ok: false` refused. */
function refused(output: string): boolean {
  try {
    const facts = JSON.parse(output) as unknown;
    return typeof facts === "object" && facts !== null && (facts as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

/**
 * The conversation, oldest first, at most `CHAT_LIMIT` items: the owner's
 * inputs, the coordinator's text (an answer after the owner spoke, its own line
 * after any other input), each tool call with its result, and the log's
 * `coordinator.message` events. Other entries (system, compaction, resets) and
 * inputs that are not the owner's are not shown.
 */
export async function readChat(
  store: EventStore,
  project: string,
  coordinator: ProjectCoordinator | undefined,
): Promise<ChatItem[]> {
  const items: ChatItem[] = [];
  for (const event of store.readSince(0, project))
    if (event.kind === "coordinator.message")
      items.push({
        kind: event.payload.role === "owner" ? "owner" : "line",
        id: `m${event.seq}`,
        at: event.at,
        body: event.payload.body,
      });
  if (coordinator) {
    const page = await coordinator.conversation.entries({ order: "descending" }, CHAT_LIMIT, undefined, context);
    items.push(...chatOf([...page.items].reverse()));
  }
  // A stable sort: same-time items keep the conversation's order.
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-CHAT_LIMIT);
}

/** pi entries, oldest first, as the room's items. */
export function chatOf(entries: readonly EntryRecord[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  let owner = true;
  let last = 0;
  const at = (message: Message | undefined) => {
    const time = message?.timestamp;
    if (typeof time === "number" && Number.isFinite(time)) last = time;
    return new Date(last).toISOString();
  };
  for (const entry of entries) {
    const message = entry.model?.[0] as Message | undefined;
    const id = `e${entry.id}`;
    if (entry.kind === "pi.user" || entry.kind === OWNER_ANSWER_ENTRY) {
      owner = true;
      const data = entry.data as { ticket?: string; choice?: string; note?: string | null } | undefined;
      const body =
        entry.kind === OWNER_ANSWER_ENTRY && data?.ticket && data.choice
          ? `On ${data.ticket}: ${data.choice}${data.note ? `. ${data.note}` : ""}`
          : textOf(message?.content);
      if (body.trim()) items.push({ kind: "owner", id, at: at(message), body });
    } else if (message?.role === "user" && entry.kind !== "pi.compaction" && entry.kind !== "pi.reset") {
      // Another input (a notice of the fleet moving): what the coordinator says to it is its own line.
      owner = false;
      at(message);
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const time = at(message);
      const body = textOf(message.content);
      if (body.trim()) items.push({ kind: owner ? "coordinator" : "line", id, at: time, body });
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          const call = {
            kind: "tool" as const,
            id: `t${entry.id}:${block.id}`,
            at: time,
            name: block.name,
            input: (block.arguments ?? {}) as Json,
            output: null,
            failed: false,
          };
          calls.set(block.id, call);
          items.push(call);
        }
    } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      const output = textOf(message.content);
      call.output = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}…` : output;
      call.failed = message.isError === true || refused(output);
    }
  }
  return items;
}
