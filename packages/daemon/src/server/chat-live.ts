// A room observes pi's committed public view. No storage reads, provider errors or document dumps reach the wire.
import {
  type ChatDelta,
  type ChatItem,
  type ChatTool,
  type ChatTurn,
  type ServerMessage,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import { reasoningOf, textOf, viewChat } from "./chat.ts";

type View = Awaited<ReturnType<Conversation["viewState"]>>;
export interface ChatClock {
  now(): number;
  setTimer(callback: () => void, delay: number): () => void;
}
const clock: ChatClock = {
  now: Date.now,
  setTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const INTERVAL = 80;
interface Subscriber {
  send(frame: ServerMessage): void;
  turn?: string;
  tools: Map<string, string>;
  partial?: string;
  sent: Map<ChatDelta["kind"], string>;
  pending: Map<ChatDelta["kind"], ChatDelta>;
  cancel?: () => void;
  lastSent?: number;
}
interface Room {
  project: string;
  ready: Promise<void>;
  readers: number;
  subscribers: Set<Subscriber>;
  value?: ConversationView;
  items: ChatItem[];
  turn: ChatTurn;
  dispose?: () => void;
  closed: boolean;
  attaching: boolean;
}

function turnOf(
  project: string,
  value: ConversationView | undefined,
  previous: ChatTurn | undefined,
  now: number,
  items: readonly ChatItem[] = [],
): ChatTurn {
  const live = value?.docs["pi.live"] as LiveState | undefined;
  const inbox = value?.docs["pi.inbox"] as InboxState | undefined;
  const slot =
    live?.tools?.find((t) => t.status === "running") ??
    live?.tools?.find((t) => t.status === "pending") ??
    live?.tools?.at(-1);
  const call = slot && items.findLast((i) => i.kind === "tool" && i.id.endsWith(`:${slot.callId}`));
  const tool = call && slot ? { id: call.id, name: slot.name } : undefined;
  const generation = live?.generation;
  const state = slot
    ? "tool"
    : !live?.run
      ? "idle"
      : generation?.retry || generation?.deferred
        ? "thinking"
        : textOf(generation?.message?.content)
          ? "writing"
          : "thinking";
  const changed = previous?.state !== state || previous?.tool?.id !== tool?.id;
  return {
    type: "chat.turn",
    version,
    project,
    state,
    since: changed ? new Date(now).toISOString() : previous.since,
    ...(tool ? { tool } : {}),
    queued: inbox?.items.filter((i) => i.mode !== "write").length ?? 0,
  };
}

/** One attached view per project, shared by subscriptions and simultaneous chat.read requests. */
export class ChatLive {
  readonly #rooms = new Map<string, Room>();
  readonly #clock: ChatClock;
  #closed = false;
  constructor(time: ChatClock = clock) {
    this.#clock = time;
  }

  #open(project: string, conversation: Conversation): Room {
    const existing = this.#rooms.get(project);
    if (existing) {
      existing.closed = false;
      return existing;
    }
    const room: Room = {
      project,
      ready: Promise.resolve(),
      subscribers: new Set(),
      readers: 0,
      items: [],
      closed: false,
      attaching: true,
      turn: turnOf(project, undefined, undefined, this.#clock.now()),
    };
    this.#rooms.set(project, room);
    room.ready = (async () => {
      const view: View = await conversation.viewState(context);
      if (room.closed) {
        view.dispose();
        return;
      }
      try {
        const update = (value: ConversationView) => {
          if (room.closed) return;
          room.value = value;
          room.items = viewChat(value);
          room.turn = turnOf(project, value, room.turn, this.#clock.now(), room.items);
          for (const subscriber of room.subscribers) this.#publish(room, subscriber);
        };
        if (view.value) update(view.value);
        const unsubscribe = view.subscribe(update);
        room.dispose = () => {
          unsubscribe();
          view.dispose();
        };
      } catch (error) {
        view.dispose();
        throw error;
      }
    })().finally(() => {
      room.attaching = false;
      if (room.closed && this.#rooms.get(project) === room) this.#rooms.delete(project);
    });
    // Listener failures expose a fixed line only. A later subscription/read can try a fresh attachment.
    void room.ready.catch(() => {
      for (const subscriber of room.subscribers)
        subscriber.send({ type: "error", version, code: "internal", message: "Could not watch the conversation" });
      this.#drop(room);
    });
    return room;
  }

  subscribe(project: string, conversation: Conversation, send: Subscriber["send"]): () => void {
    if (this.#closed) return () => {};
    const room = this.#open(project, conversation);
    const subscriber: Subscriber = { send, tools: new Map(), sent: new Map(), pending: new Map() };
    room.subscribers.add(subscriber);
    if (room.value) this.#publish(room, subscriber);
    return () => {
      subscriber.cancel?.();
      room.subscribers.delete(subscriber);
      if (!room.subscribers.size && !room.readers) this.#drop(room);
    };
  }

  async read(
    project: string,
    conversation: Conversation | undefined,
  ): Promise<{ value?: ConversationView; turn: ChatTurn }> {
    if (this.#closed) throw new Error("Chat views are closed");
    if (!conversation) return { turn: turnOf(project, undefined, undefined, this.#clock.now()) };
    const room = this.#open(project, conversation);
    room.readers++;
    try {
      await room.ready;
      return { value: room.value, turn: room.turn };
    } finally {
      room.readers--;
      if (!room.subscribers.size && !room.readers) this.#drop(room);
    }
  }

  #publish(room: Room, subscriber: Subscriber): void {
    const value = room.value;
    if (!value) return;
    const turn = JSON.stringify(room.turn);
    if (subscriber.turn !== turn) {
      subscriber.turn = turn;
      subscriber.send(room.turn);
    }
    const live = value.docs["pi.live"] as LiveState | undefined;
    const tools = room.items.filter((i) => i.kind === "tool").slice(-200);
    const retained = new Set(tools.map((t) => t.id));
    for (const id of subscriber.tools.keys()) if (!retained.has(id)) subscriber.tools.delete(id);
    const active = new Set(
      (live?.tools ?? []).map((slot) => tools.findLast((item) => item.id.endsWith(`:${slot.callId}`))?.id),
    );
    for (const item of tools) {
      if (!active.has(item.id) && !subscriber.tools.has(item.id)) continue;
      const { kind: _, ...call } = item;
      const tool: ChatTool = {
        ...call,
        type: "chat.tool",
        version,
        project: room.project,
      };
      const serialized = JSON.stringify(tool);
      if (subscriber.tools.get(tool.id) !== serialized) {
        subscriber.tools.set(tool.id, serialized);
        subscriber.send(tool);
      }
    }
    const message = live?.generation?.message;
    const task = live?.run?.taskId;
    const ordinal = value.entries.filter((e) => e.kind === "pi.assistant" && e.byTaskId === task).length + 1;
    const id = message && task !== undefined ? `g${task}:${ordinal}` : undefined;
    if (subscriber.partial !== id) {
      subscriber.cancel?.();
      subscriber.cancel = undefined;
      subscriber.pending.clear();
      subscriber.sent.clear();
      subscriber.partial = id;
    }
    if (!id) return;
    for (const [kind, text] of [
      ["text", textOf(message?.content)],
      ["reasoning", reasoningOf(message?.content)],
    ] as const) {
      if (subscriber.sent.get(kind) === text) subscriber.pending.delete(kind);
      else if (text || subscriber.sent.has(kind))
        subscriber.pending.set(kind, { type: "chat.delta", version, project: room.project, id, kind, text });
    }
    this.#schedule(subscriber);
  }

  #schedule(subscriber: Subscriber): void {
    if (!subscriber.pending.size || subscriber.cancel) return;
    const delay = Math.max(INTERVAL, (subscriber.lastSent ?? -Infinity) + INTERVAL - this.#clock.now());
    subscriber.cancel = this.#clock.setTimer(() => {
      subscriber.cancel = undefined;
      const frame = subscriber.pending.values().next().value;
      if (!frame) return;
      subscriber.pending.delete(frame.kind);
      subscriber.lastSent = this.#clock.now();
      subscriber.sent.set(frame.kind, frame.text);
      subscriber.send(frame);
      // One frame per subscriber per interval, fair between text and reasoning.
      this.#schedule(subscriber);
    }, delay);
  }

  #drop(room: Room): void {
    room.closed = true;
    for (const subscriber of room.subscribers) subscriber.cancel?.();
    room.dispose?.();
    room.dispose = undefined;
    // Keep an unresolved attachment owned: a reconnect reuses it, shutdown awaits it.
    if (!room.attaching && this.#rooms.get(room.project) === room) this.#rooms.delete(room.project);
  }
  async close(): Promise<void> {
    this.#closed = true;
    const rooms = [...this.#rooms.values()];
    for (const room of rooms) this.#drop(room);
    await Promise.allSettled(rooms.map((room) => room.ready));
  }
}
