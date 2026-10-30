import type { Phase, Ticket } from "@armada/daemon/events";

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
  tickets: TrackerTicket[];
  comments: TrackerComment[];
}
export interface Tracker {
  read(input: { previous?: TrackerReading; signal: AbortSignal }): Promise<TrackerReading>;
}
