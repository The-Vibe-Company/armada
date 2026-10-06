import type { Lease } from "./live.ts";

export const MERGE_QUEUE_LEASE = "merge-queue";
export type QueueState = "queued" | "merging" | "merged" | "refused" | "removed";
export interface QueueInput {
  pr: number;
  ticket: string | null;
  noTicket: boolean;
  keepOpen: boolean;
  throughHold: string | null;
  reason: string | null;
  headSha: string;
  queuedBy: string;
}
export interface QueueEntry extends QueueInput {
  id: number;
  project: string;
  state: QueueState;
  detail: string | null;
  attempts: number;
  notBefore: string | null;
  queuedAt: string;
  updatedAt: string;
  mergeCommit: string | null;
  finishedAt: string | null;
}
export type QueueAdded = { id: number; position: number } | { existing: QueueEntry };
/** Shared merge holds are supplied here once the hold store is available. */
export interface QueueHold {
  id: number;
  reason: string;
}
export type QueueNext = { entry: QueueEntry | null; holds: QueueHold[] } | { refused: true; held: Lease | null };
export interface QueueFinish {
  id: number;
  holder: string;
  /** Paused restores queued intent without counting a failed attempt. */
  outcome: "merged" | "refused" | "retry" | "paused";
  detail: string | null;
  mergeCommit?: string | null;
  notBefore?: string | null;
}
/** The drain's current step on the entry it merges ("Waiting: checks running on …"). */
export interface QueueProgress {
  id: number;
  holder: string;
  detail: string;
}
/** How long open entries may sit with nobody draining them before the coordinator is woken. */
export const QUEUE_STALL_MS = 2 * 60_000;
/** How a `queue-refused` inbox item starts; queuing the same pull request again resolves it. */
export const queueRefusedPrefix = (pr: number) => `PR #${pr} refused:`;
export const queueOpen = (e: QueueEntry) => e.state === "queued" || e.state === "merging";

/** How long a refused entry stays shown after its refusal. */
export const REFUSED_SHOWN_MS = 24 * 60 * 60_000;

/**
 * The queue as status and the dashboard show it: the open entries in drain
 * order (the one merging first), then the entries refused within a day whose
 * pull request was not queued again, newest first.
 */
export function shownQueue(entries: readonly QueueEntry[], now: Date): QueueEntry[] {
  const open = entries
    .filter(queueOpen)
    .sort(
      (a, b) =>
        Number(b.state === "merging") - Number(a.state === "merging") ||
        a.queuedAt.localeCompare(b.queuedAt) ||
        a.id - b.id,
    );
  const since = now.getTime() - REFUSED_SHOWN_MS;
  const refused = entries
    .filter(
      (e) =>
        e.state === "refused" &&
        Date.parse(e.finishedAt ?? e.updatedAt) >= since &&
        !entries.some((o) => o.pr === e.pr && o.id > e.id),
    )
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "") || b.id - a.id);
  return [...open, ...refused];
}
