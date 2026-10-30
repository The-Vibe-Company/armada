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
import type { EntryRecord, SubmissionDraft } from "@earendil-works/pi-durable";
import type { ProjectCoordinator } from "../../coordinator/index.ts";
import type { Json } from "../events.ts";
import { fold } from "../fold.ts";
import type { EventStore } from "../store.ts";

/** At most this many items of a long conversation: its latest. */
const CHAT_LIMIT = 200;
/** A tool's result past this many characters is cut: the room shows a reading, not a dump. */
const OUTPUT_LIMIT = 8 * 1024;
/** The input entry the owner's answer to a pinned question is placed as (reserved: entry-kind). */
const OWNER_ANSWER_ENTRY = "armada.owner-answer";

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
        // Mid-run, the owner steers: the message joins the running work after its tool round,
        // and shows in the conversation then, rather than waiting for the whole run to end.
        await options.coordinator.conversation.submit(
          { type: "input", content: request.body, requestId: request.requestId, whenBusy: "steer" },
          context,
        );
        return { type: "chat.sent", version, id, project, requestId: request.requestId };
      }
      case "owner.answer": {
        const answer = recordAnswer(request, options);
        if (answer === "missing") return error("not-found", "No such question waits for you");
        if (answer === "taken") return error("not-found", "This question was already answered");
        if (options.coordinator)
          try {
            await options.coordinator.conversation.submit(answer, context);
          } catch {
            return error(
              "internal",
              "Your answer is recorded, but the coordinator was not told: answer the same again",
            );
          }
        return { type: "owner.answered", version, id, project, item: request.item };
      }
    }
  } catch {
    return error("internal", request.type === "chat.read" ? "Could not read the conversation" : "Could not send it");
  }
}

const NOTE = "\n\nNote: ";

/**
 * Records the owner's answer to an open `owner-request` (the fold and the
 * append run without a wait between them: two answers cannot both land) and
 * returns the coordinator's input that tells it, keyed by the item. The same
 * answer again, once recorded, returns that input again: a coordinator that
 * was not told gets it, one that was gets nothing new (pi admits it once).
 */
function recordAnswer(
  request: OwnerAnswerRequest,
  options: ChatOptions,
): "missing" | "taken" | Extract<SubmissionDraft, { type: "input" }> {
  const { store, project, item } = { ...options, ...request };
  const events = store.readSince(0, project);
  const asked = events.find(
    (e) => e.kind === "inbox.opened" && e.payload.id === item && e.payload.kind === "owner-request",
  );
  if (asked?.kind !== "inbox.opened") return "missing";
  const note = request.note?.trim() || null;
  const answer = note ? `${request.choice}${NOTE}${note}` : request.choice;
  if (fold(events).projects[project]?.inbox.some((i) => i.id === item)) {
    store.append({
      project,
      kind: "inbox.answered",
      at: new Date((options.now ?? Date.now)()).toISOString(),
      actor: "owner",
      payload: { id: item, answer },
    });
  } else {
    const recorded = events.findLast((e) => e.kind === "inbox.answered" && e.payload.id === item);
    if (recorded?.kind !== "inbox.answered" || recorded.actor !== "owner" || recorded.payload.answer !== answer)
      return "taken";
  }
  const ticket = asked.payload.ticket;
  return {
    type: "input",
    content: `The owner answered ${ticket}'s question: ${request.choice}${note ? `\nNote: ${note}` : ""}`,
    requestId: `owner-answer:${item}`,
    whenBusy: "steer",
    entry: { kind: OWNER_ANSWER_ENTRY, data: { ticket, choice: request.choice, note } },
  };
}

type Message = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
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
async function readChat(
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
function chatOf(entries: readonly EntryRecord[]): ChatItem[] {
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
      else if (message.stopReason === "error")
        // A turn the model failed says so, rather than leaving the owner to silence.
        items.push({
          kind: "line",
          id,
          at: time,
          // A fixed line: a provider's error text could echo what it was sent.
          body: "The coordinator's model failed on this turn.",
        });
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
