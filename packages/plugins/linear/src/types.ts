import type { Phase, Ticket } from "@armada/daemon/events";
import type { LinearBudget } from "./linear/budget.ts";

export interface TrackerTicket {
  uuid: string;
  id: string;
  title: string;
  description?: string;
  branchName?: string;
  blockers?: { id: string; status: Ticket["status"] }[];
  status: Ticket["status"];
  phase: Phase | null;
  owner: string | null;
  parent: string | null;
  url: string;
  labels: string[];
  attachments: { title: string; url: string }[];
}
export interface TrackerComment {
  id: string;
  ticket: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}
/** A complete reading; incremental providers merge changes into the previous reading. */
export interface TrackerReading {
  startedAt: string;
  /** Last entity updatedAt seen; startedAt remains the conservative issue/comment watermark. */
  updatedAt?: string;
  tickets: TrackerTicket[];
  comments: TrackerComment[];
}
export interface Tracker {
  /** Stable reader configuration; checkpoints from another scope must never be reused. */
  identity?: string;
  /** Credential fingerprint, never the credential; only matching quota observations are restored. */
  quota?: string;
  prepare?(): Promise<void>;
  budget?: LinearBudget;
  read(input: { previous?: TrackerReading; signal: AbortSignal }): Promise<TrackerReading>;
}
