// The room's conversation with a project's coordinator (THE-1996). The daemon
// reads it (`chat.read`: pi's conversation and the log's coordinator lines);
// the app reads it again whenever the subscription brings a `coordinator.*`
// event past its last reading, so the coordinator's answer appears as soon as
// its checkpoint lands. A message keeps one requestId until the daemon
// admitted it: sent again after a drop, it is the same message.
import { CHAT_MINOR, type ChatItem } from "@armada/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectLog } from "@/protocol/client";
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
  /** Sends one message; rejects with the daemon's line. */
  send(body: string): Promise<void>;
  /** The owner's answer to a question pinned in the room. */
  answer(item: string, choice: string, note: string): Promise<void>;
}

/** The cursor of the project's last coordinator event the subscription brought (0 for none). */
export function lastCoordinatorSeq(log: ProjectLog | undefined): number {
  const events = log?.events ?? [];
  for (let k = events.length - 1; k >= 0; k--) {
    const event = events[k];
    if (event?.kind.startsWith("coordinator.")) return event.seq;
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
  const latest = useMemo(() => lastCoordinatorSeq(logs[project]), [logs, project]);
  const [read, setRead] = useState<{
    project: string;
    seq: number;
    coordinator: boolean;
    items: readonly ChatItem[];
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
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
        if (!current) return;
        setRead({ project, seq: r.seq, coordinator: r.coordinator, items: r.items });
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (current) setProblem(error instanceof Error ? error.message : "Could not read the conversation");
      });
    return () => {
      current = false;
    };
  }, [client, project, live, able, stale, latest, seq]);

  const draft = useRef<{ body: string; id: string } | null>(null);
  const send = useCallback(
    async (body: string) => {
      if (draft.current?.body !== body) draft.current = { body, id: newId() };
      await client.request({ type: "chat.send", project, requestId: draft.current.id, body });
      draft.current = null;
    },
    [client, project],
  );
  const answer = useCallback(
    async (item: string, choice: string, note: string) => {
      const said = note.trim();
      await client.request({ type: "owner.answer", project, item, choice, ...(said ? { note: said } : {}) });
    },
    [client, project],
  );

  return {
    status: minor !== null && !able ? "unavailable" : mine ? "ready" : "reading",
    coordinator: mine?.coordinator ?? null,
    items: mine?.items ?? [],
    problem,
    send,
    answer,
  };
}
