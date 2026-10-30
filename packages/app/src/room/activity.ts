// What each project's coordinator does and said, for the sidebar (THE-2054):
// its turn as the daemon streams it (every subscribed project's `chat.turn`
// frames), and when it spoke, read once per turn's end (`chat.read` when the
// project's coordinator log moved past the last reading and no turn runs).
// The open room reads its own conversation: its project is not read here.
import { CHAT_MINOR, type ChatTurn } from "@armada/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDaemon, useDaemonClient } from "@/protocol/store";
import {
  browserSeen,
  coordinatorTimes,
  failedTurn,
  lastCoordinatorSeq,
  markSeen,
  onSeen,
  type SeenStorage,
  seenOf,
} from "./unread";

interface Reading {
  seq: number;
  /** When the coordinator spoke, oldest first. */
  times: readonly string[];
  failed: boolean;
}

export interface ProjectActivity {
  turn: ChatTurn | null;
  /** The coordinator's items past the project's watermark (0 until read). */
  times: readonly string[];
  seen: string | null;
  failed: boolean;
}

const NOTHING: ProjectActivity = { turn: null, times: [], seen: null, failed: false };

function useSeenVersion(): number {
  const version = useRef(0);
  return useSyncExternalStore(
    (listener) => {
      const heard = () => {
        version.current += 1;
        listener();
      };
      const off = onSeen(heard);
      window.addEventListener("storage", heard);
      return () => {
        off();
        window.removeEventListener("storage", heard);
      };
    },
    () => version.current,
    () => 0,
  );
}

/** Each project's coordinator activity; `open` is the project whose room is shown (never read here). */
export function useProjectsActivity(
  open: string | null,
  storage: SeenStorage | null = browserSeen(),
): (project: string) => ProjectActivity {
  const client = useDaemonClient();
  const { status, minor, logs, projects } = useDaemon();
  const live = status === "live";
  const [turns, setTurns] = useState<Readonly<Record<string, ChatTurn>>>({});
  const [readings, setReadings] = useState<Readonly<Record<string, Reading>>>({});
  const asking = useRef(new Set<string>());
  useSeenVersion();

  useEffect(
    () =>
      client.chat((frame) => {
        if (frame.type === "chat.turn") setTurns((held) => ({ ...held, [frame.project]: frame }));
      }),
    [client],
  );
  // The daemon sends each turn again on a new subscription: a drop forgets them.
  useEffect(() => {
    if (!live) setTurns({});
  }, [live]);

  useEffect(() => {
    if (!live || minor === null || minor < CHAT_MINOR) return;
    for (const { id } of projects ?? []) {
      if (id === open || asking.current.has(id)) continue;
      const latest = lastCoordinatorSeq(logs[id]);
      const held = readings[id];
      if (held && held.seq >= latest) continue;
      // Read once the turn ends, not on each of its checkpoints (but always once, for the watermark's baseline).
      const turn = turns[id];
      if (held && turn && turn.state !== "idle") continue;
      asking.current.add(id);
      client
        .request({ type: "chat.read", project: id })
        .then((r) => {
          asking.current.delete(id);
          const times = coordinatorTimes(r.items);
          // A project read for the first time starts with nothing unread (T3 Code shows nothing without a visit).
          if (!seenOf(storage, id)) markSeen(storage, id, times.at(-1) ?? new Date().toISOString());
          setReadings((all) => ({
            ...all,
            [id]: { seq: Math.max(r.seq, latest), times, failed: failedTurn(r.items) },
          }));
        })
        .catch(() => {
          asking.current.delete(id);
          // Not read: the next move of its log asks again.
          setReadings((all) => ({ ...all, [id]: { seq: latest, times: all[id]?.times ?? [], failed: false } }));
        });
    }
  }, [client, live, minor, logs, projects, open, readings, turns, storage]);

  return (project) => {
    const reading = readings[project];
    const turn = live ? (turns[project] ?? null) : null;
    if (!reading && !turn) return NOTHING;
    return { turn, times: reading?.times ?? [], seen: seenOf(storage, project), failed: reading?.failed ?? false };
  };
}
