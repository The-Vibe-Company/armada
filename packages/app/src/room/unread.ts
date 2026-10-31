// What the owner has not read yet, per project (THE-2054), after T3 Code's
// visit watermark (`ThreadVisitWatermark.tsx`) and its sidebar's status pills
// (`Sidebar.logic.ts`): the room records the latest coordinator item seen
// while it is open and the window focused; a project's line in the sidebar
// counts the coordinator's items past it, and says what the coordinator does.
import { CHAT_MODEL_FAILED, type ChatItem, type ChatTurn } from "@armada/protocol";
import type { FleetState, FoldedInboxItem } from "@/fleet/state";
import type { ProjectLog } from "@/protocol/client";

/** Last conversation event, excluding reader freshness checkpoints (0 for none). */
export function lastCoordinatorSeq(log: ProjectLog | undefined): number {
  const events = log?.events ?? [];
  for (let k = events.length - 1; k >= 0; k--) {
    const event = events[k];
    if (event?.kind.startsWith("coordinator.") && event.actor !== "reader") return event.seq;
  }
  return 0;
}

/** The questions waiting for the owner, oldest first: the open owner requests of the fold's inbox. */
export const ownerQuestions = (state: FleetState): FoldedInboxItem[] =>
  state.inbox.filter((i) => i.kind === "owner-request");

export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SEEN_KEY = (project: string) => `armada.room.seen.${project}`;

export const browserSeen = (): SeenStorage | null => (typeof localStorage === "undefined" ? null : localStorage);

const listeners = new Set<() => void>();

/** Hears every watermark moved in this window (another window's `storage` event too). */
export function onSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function seenOf(storage: SeenStorage | null, project: string): string | null {
  try {
    return storage?.getItem(SEEN_KEY(project)) ?? null;
  } catch {
    return null;
  }
}

/** Moves the project's watermark to `at`, never back; says whether it moved. */
export function markSeen(storage: SeenStorage | null, project: string, at: string): boolean {
  const held = seenOf(storage, project);
  if (!storage || !Number.isFinite(Date.parse(at)) || (held && Date.parse(held) >= Date.parse(at))) return false;
  try {
    storage.setItem(SEEN_KEY(project), at);
  } catch {
    return false;
  }
  for (const listener of listeners) listener();
  return true;
}

/** What counts as the coordinator speaking: its answers and its own lines (never a call, never the owner). */
const said = (item: ChatItem) => item.kind === "coordinator" || item.kind === "line";

/** When the coordinator said each thing in a reading, oldest first. */
export const coordinatorTimes = (items: readonly ChatItem[]): string[] => items.filter(said).map((i) => i.at);

/** The coordinator's items past the watermark; none without one (the first reading sets it). */
export function unreadCount(times: readonly string[], seen: string | null): number {
  if (!seen) return 0;
  const mark = Date.parse(seen);
  return times.filter((at) => Date.parse(at) > mark).length;
}

/** Whether the reading's last coordinator item says the model failed its turn. */
export function failedTurn(items: readonly ChatItem[]): boolean {
  const last = items.findLast(said);
  return last?.kind === "line" && last.body === CHAT_MODEL_FAILED;
}

type PillLabel = "Working" | "Awaiting input" | "Failed";
export interface StatusPill {
  label: PillLabel;
  /** The word's colour, then the dot's. */
  text: string;
  dot: string;
  pulse: boolean;
}

const PILLS: Record<PillLabel, StatusPill> = {
  "Awaiting input": { label: "Awaiting input", text: "text-amber", dot: "bg-amber", pulse: false },
  Working: { label: "Working", text: "text-blue", dot: "bg-blue", pulse: true },
  Failed: { label: "Failed", text: "text-red", dot: "bg-red", pulse: false },
};

/**
 * The coordinator's state on its project's line: a question waiting for the
 * owner first, then a turn running, then a turn the model failed; nothing when idle.
 */
export function statusPill({
  turn,
  waiting,
  failed,
}: {
  turn: ChatTurn | null;
  waiting: number;
  failed: boolean;
}): StatusPill | null {
  if (waiting > 0) return PILLS["Awaiting input"];
  if (turn && turn.state !== "idle") return PILLS.Working;
  if (failed) return PILLS.Failed;
  return null;
}
