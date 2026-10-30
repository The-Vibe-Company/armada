// The room's conversation with a project's coordinator (THE-1996). The daemon
// reads it (`chat.read`: pi's conversation and the log's coordinator lines);
// the app reads it again whenever the subscription brings a `coordinator.*`
// event past its last reading, so the coordinator's answer appears as soon as
// its checkpoint lands. A message keeps one requestId until the daemon
// admitted it: sent again after a drop, it is the same message. On a daemon of
// CHAT_LIVE_MINOR (THE-2052), the turn streams beside the reading: its state,
// the answer and its reasoning as they are written, the tool calls as they
// run; a reading that holds an answer or a call replaces it under the same id.
import { CHAT_LIVE_MINOR, CHAT_MINOR, type ChatItem, type ChatTurn } from "@armada/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatFrame, ProjectLog } from "@/protocol/client";
import { useDaemon, useDaemonClient } from "@/protocol/store";

export const NO_CHAT = "This daemon has no chat: update it.";

export interface Chat {
  /** `unavailable`: a daemon older than the chat; `reading`: the first reading is on its way. */
  status: "unavailable" | "reading" | "ready";
  /** Whether a coordinator runs for the project; null until read. */
  coordinator: boolean | null;
  items: readonly ChatItem[];
  /** The last reading's failure, in one line. */
  problem: string | null;
  /** Sends one message; rejects with the daemon's line. Mid-turn it steers, or waits for the turn's end (`queue`). */
  send(body: string, whenBusy?: WhenBusy): Promise<void>;
  /** The owner's answer to a question pinned in the room. */
  answer(item: string, choice: string, note: string): Promise<void>;
  /** The coordinator's turn as it streams; null on a daemon older than CHAT_LIVE_MINOR (nothing live, no Stop). */
  live?: Live | null;
  /** Interrupts the coordinator's turn (`chat.stop`); rejects with the daemon's line. */
  stop?(): Promise<void>;
  /** The owner's messages queued for the turn's end, not yet in a reading: shown apart, under the thread. */
  queued?: readonly ChatItem[];
  /**
   * The owner's messages a Stop withdrew before the coordinator took them (pi's
   * abort withdraws every waiting input), given back to the field; a new `key` for each Stop.
   */
  withdrawn?: { key: number; bodies: readonly string[] } | null;
}

export type WhenBusy = "steer" | "queue";
type ToolItem = Extract<ChatItem, { kind: "tool" }>;
/** An answer as it is written: its text and its reasoning so far, under the id its item will have. */
export interface Streaming {
  kind: "streaming";
  id: string;
  at: string;
  text: string;
  reasoning: string;
}
/** What streamed of the turn and is not in the reading yet, oldest first. */
export type LiveEntry = Streaming | (ToolItem & { live: true });

export interface Live {
  /** The turn's state as the daemon last said it; null before it said any. */
  turn: ChatTurn | null;
  /** When the turn began, if this app saw it begin; null for one joined mid-way ("Working…"). */
  started: string | null;
  entries: readonly LiveEntry[];
}

export const NO_LIVE: Live = { turn: null, started: null, entries: [] };

/** The live turn after one of the daemon's frames (already the room's project). */
export function applyFrame(live: Live, frame: ChatFrame): Live {
  switch (frame.type) {
    case "chat.turn": {
      const busy = frame.state !== "idle";
      // Seen to begin (after an idle turn), it counts from then; joined mid-way, it has no start.
      const started = !busy ? null : live.turn?.state === "idle" ? frame.since : live.started;
      return { ...live, turn: frame, started };
    }
    case "chat.delta": {
      const k = live.entries.findIndex((e) => e.kind === "streaming" && e.id === frame.id);
      const held = k >= 0 ? (live.entries[k] as Streaming) : null;
      const next: Streaming = held
        ? { ...held, [frame.kind]: frame.text }
        : {
            kind: "streaming",
            id: frame.id,
            at: live.turn?.since ?? new Date().toISOString(),
            text: frame.kind === "text" ? frame.text : "",
            reasoning: frame.kind === "reasoning" ? frame.text : "",
          };
      return { ...live, entries: k >= 0 ? live.entries.with(k, next) : [...live.entries, next] };
    }
    case "chat.tool": {
      const { type: _, version: __, project: ___, ...call } = frame;
      const next = { kind: "tool" as const, ...call, live: true as const };
      const k = live.entries.findIndex((e) => e.kind === "tool" && e.id === frame.id);
      return { ...live, entries: k >= 0 ? live.entries.with(k, next) : [...live.entries, next] };
    }
  }
}

/**
 * The live turn once a reading landed: the answers it holds leave (their item
 * takes their place, same id), and the calls it holds ended; its turn stands
 * for the daemon's until a frame says otherwise.
 */
export function afterReading(live: Live, items: readonly ChatItem[], turn: ChatTurn | undefined): Live {
  const held = new Map(items.map((i) => [i.id, i]));
  const entries = live.entries.filter((e) => {
    // Blank words before a call never become an item: nothing waits for them.
    if (e.kind === "streaming" && blank(e)) return false;
    const item = held.get(e.id);
    if (!item) return true;
    return e.kind === "tool" && item.kind === "tool" && item.output === null;
  });
  const seeded = live.turn ?? turn ?? null;
  return {
    turn: seeded,
    started: live.turn ? live.started : null,
    entries: entries.length === live.entries.length ? live.entries : entries,
  };
}

const blank = (e: Streaming) => !e.text.trim() && !e.reasoning.trim();

/** One row of the thread: an item read, or an answer still being written. */
export type ThreadItem = ChatItem | Streaming;

/**
 * The thread as drawn: the reading (a call that streams shows its latest
 * state in its place), then what streamed that it does not hold yet.
 */
export function threadItems(items: readonly ChatItem[], live: Live | null | undefined): readonly ThreadItem[] {
  if (!live?.entries.length) return items;
  const streamed = new Map(live.entries.map((e) => [e.id, e]));
  const read = new Set(items.map((i) => i.id));
  return [
    ...items.map((i) => {
      const call = i.kind === "tool" ? streamed.get(i.id) : undefined;
      return call?.kind === "tool" ? call : i;
    }),
    ...live.entries.filter((e) => !read.has(e.id) && !(e.kind === "streaming" && blank(e))),
  ];
}

/** Last conversation event, excluding reader freshness checkpoints (0 for none). */
export function lastCoordinatorSeq(log: ProjectLog | undefined): number {
  const events = log?.events ?? [];
  for (let k = events.length - 1; k >= 0; k--) {
    const event = events[k];
    if (event?.kind.startsWith("coordinator.") && event.actor !== "reader") return event.seq;
  }
  return 0;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function useChat(project: string): Chat {
  const client = useDaemonClient();
  const { status, minor, logs } = useDaemon();
  const live = status === "live";
  const able = minor !== null && minor >= CHAT_MINOR;
  const streams = minor !== null && minor >= CHAT_LIVE_MINOR;
  const latest = useMemo(() => lastCoordinatorSeq(logs[project]), [logs, project]);
  const [read, setRead] = useState<{
    project: string;
    seq: number;
    coordinator: boolean;
    items: readonly ChatItem[];
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [turn, setTurn] = useState<{ project: string; live: Live }>({ project, live: NO_LIVE });
  const current = turn.project === project && live ? turn.live : NO_LIVE;
  // Listening from the start, so no frame of a new subscription is missed; only a daemon of CHAT_LIVE_MINOR sends them.
  useEffect(
    () =>
      client.chat((frame) => {
        if (frame.project !== project) return;
        setTurn((held) => ({ project, live: applyFrame(held.project === project ? held.live : NO_LIVE, frame) }));
      }),
    [client, project],
  );
  // The daemon sends the turn again on each subscription: a drop starts from nothing.
  useEffect(() => {
    if (!live) setTurn({ project, live: NO_LIVE });
  }, [live, project]);
  const draft = useRef<{ body: string; id: string } | null>(null);
  // Sent and admitted, not yet in a reading (the coordinator places it after its tool round).
  const [sent, setSent] = useState<Sent[]>([]);
  const sentNow = useRef(sent);
  sentNow.current = sent;
  const [withdrawn, setWithdrawn] = useState<{ key: number; bodies: readonly string[] } | null>(null);
  const land = useCallback(
    (r: { seq: number; coordinator: boolean; items: ChatItem[]; turn?: ChatTurn }) => {
      setRead({ project, seq: r.seq, coordinator: r.coordinator, items: r.items });
      setTurn((held) => ({
        project,
        live: afterReading(held.project === project ? held.live : NO_LIVE, r.items, r.turn),
      }));
      // A message the conversation holds is no longer on its way: only those still waiting stay.
      setSent((list) => {
        const waiting = list.filter((m) => m.project !== project || !holds(r.items, m));
        return waiting.length === list.length ? list : waiting;
      });
      setProblem(null);
    },
    [project],
  );
  const mine = read?.project === project ? read : null;
  const stale = !mine || latest > mine.seq;
  const seq = mine?.seq;
  // Read when the reading is missing or behind the log; a reconnect (`live`) or a newer reading asks again if still behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seq` and `latest` decide `stale`; a new one asks again.
  useEffect(() => {
    if (!live || !able || !stale) return;
    let current = true;
    client
      .request({ type: "chat.read", project })
      .then((r) => {
        if (current) land(r);
      })
      .catch((error: unknown) => {
        if (current) setProblem(error instanceof Error ? error.message : "Could not read the conversation");
      });
    return () => {
      current = false;
    };
  }, [client, project, live, able, stale, latest, seq, land]);

  const send = useCallback(
    async (body: string, whenBusy?: WhenBusy) => {
      if (draft.current?.body !== body) draft.current = { body, id: newId() };
      const id = draft.current.id;
      await client.request({
        type: "chat.send",
        project,
        requestId: id,
        body,
        ...(whenBusy === "queue" ? { whenBusy } : {}),
      });
      draft.current = null;
      setSent((list) => [
        ...list,
        { project, id, body, at: Date.now(), ...(whenBusy === "queue" ? { queued: true } : {}) },
      ]);
    },
    [client, project],
  );
  // pi's abort withdraws every input still waiting (queued, or steered and not yet placed): the reading right
  // after the Stop says which, and their words go back to the owner's field rather than vanish.
  const stop = useCallback(async () => {
    const asked = Date.now();
    await client.request({ type: "chat.stop", project });
    // The coordinator stopped; what follows is best effort (the next checkpoint's reading lands as ever).
    const r = await client.request({ type: "chat.read", project }).catch(() => null);
    if (!r) return;
    land(r);
    // Every message sent stays listed only until a reading holds it: those listed here were still waiting.
    const gone = sentNow.current.filter((m) => m.project === project && m.at <= asked && !holds(r.items, m));
    if (!gone.length) return;
    const ids = new Set(gone.map((m) => m.id));
    setSent((list) => list.filter((m) => !ids.has(m.id)));
    setWithdrawn((last) => ({ key: (last?.key ?? 0) + 1, bodies: gone.map((m) => m.body) }));
  }, [client, project, land]);
  const answer = useCallback(
    async (item: string, choice: string, note: string) => {
      const said = note.trim();
      await client.request({ type: "owner.answer", project, item, choice, ...(said ? { note: said } : {}) });
    },
    [client, project],
  );

  const items = useMemo(
    () =>
      withSent(
        mine?.items ?? [],
        sent.filter((m) => !m.queued),
        project,
      ),
    [mine, sent, project],
  );
  const queued = useMemo(() => {
    const read = mine?.items ?? [];
    return withSent(
      read,
      sent.filter((m) => m.queued),
      project,
    ).slice(read.length);
  }, [mine, sent, project]);
  return {
    status: minor !== null && !able ? "unavailable" : mine ? "ready" : "reading",
    coordinator: mine?.coordinator ?? null,
    items,
    problem,
    send,
    answer,
    live: streams ? current : null,
    stop,
    queued,
    withdrawn,
  };
}

type Sent = { project: string; id: string; body: string; at: number; queued?: true };

/** Whether a reading holds a message sent: an owner item with the same words, said from a moment before it was sent. */
const holds = (items: readonly ChatItem[], m: { body: string; at: number }) =>
  items.some((i) => i.kind === "owner" && i.body === m.body && Date.parse(i.at) >= m.at - 5_000);

/**
 * The reading, then the owner's messages sent since that it does not hold yet
 * (an owner item with the same words, said from a moment before it was sent,
 * stands for it), so a message never vanishes between Send and its turn.
 */
export function withSent(
  items: readonly ChatItem[],
  sent: readonly { project: string; id: string; body: string; at: number }[],
  project: string,
): readonly ChatItem[] {
  const waiting = sent.filter((m) => m.project === project && !holds(items, m));
  if (!waiting.length) return items;
  return [
    ...items,
    ...waiting.map((m) => ({
      kind: "owner" as const,
      id: `sent:${m.id}`,
      at: new Date(m.at).toISOString(),
      body: m.body,
    })),
  ];
}
