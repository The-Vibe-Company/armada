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
  outcome: "merged" | "refused" | "retry";
  detail: string | null;
  mergeCommit?: string | null;
  notBefore?: string | null;
}
export const queueOpen = (e: QueueEntry) => e.state === "queued" || e.state === "merging";
