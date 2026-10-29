// Local V2 contracts until THE-1985 moves the event vocabulary into packages/protocol.
// No V1 imports: the log is shared by every daemon adapter and can be replayed offline.
export type Phase =
  | "planning"
  | "awaiting-approval"
  | "implementing"
  | "shipping"
  | "blocked"
  | "ready-to-merge"
  | "awaiting-validation"
  | "released"
  | "merged";
export type ShippingStage = "review" | "ci";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Ticket {
  id: string;
  title: string;
  status: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  phase?: Phase | null;
  reason?: string;
  owner?: string;
}
export interface PullRequest {
  number: number;
  ticket: string;
  state: "open" | "closed" | "merged";
  ci: "none" | "pending" | "success" | "failure";
  conflicting: boolean;
  head: string;
}
export interface SessionRef {
  ticket: string;
  /** Unique for each claim; never reuse a runtime handle as a generation. */
  session: string;
}
export interface InboxRequest {
  id: string;
  ticket: string;
  kind: "question" | "plan" | "hand-back" | "owner-request" | "launch";
  body: string;
}
export interface ValidationRequest {
  id: string;
  ticket: string;
  session: string;
  question: string;
  checks: string[];
}
export interface EventPayloads {
  "ticket.seen": Ticket;
  "pull-request.seen": PullRequest;
  "session.claimed": SessionRef & { generation: number; owner: string; runtime: string; handle: string };
  "session.reported": SessionRef & {
    phase: Exclude<Phase, "released" | "merged">;
    reason: string;
    stage?: ShippingStage;
  };
  "session.heartbeat": SessionRef;
  "session.released": SessionRef & { reason: string };
  "inbox.opened": InboxRequest;
  "inbox.answered": { id: string; answer: string };
  "merge.queued": SessionRef & { id: string; pr: number; head: string };
  "merge.started": { id: string };
  "merge.refused": { id: string; reason: string };
  "merge.canceled": { id: string; reason: string };
  "merge.confirmed": SessionRef & { id: string; pr: number; head: string };
  "hold.opened": { id: string; reason: string };
  "hold.cleared": { id: string; reason: string };
  "validation.opened": ValidationRequest;
  "validation.decided": { id: string; decision: "approved" | "changes-requested"; note: string };
  "coordinator.message": { role: "owner" | "coordinator"; body: string };
  "coordinator.checkpoint": { checkpoint: Json };
  "pull-request.opened": GithubPullRequest;
  "pull-request.head-moved": GithubPullRequest;
  "pull-request.checks-green": GithubPullRequest;
  "pull-request.checks-red": GithubPullRequest;
  "pull-request.review-changed": GithubPullRequest;
  "pull-request.closed": GithubPullRequest;
  "pull-request.merged": GithubPullRequest;
}
export type EventKind = keyof EventPayloads;
export type EventInput = {
  [K in EventKind]: { project: string; kind: K; at: string; actor: string; payload: EventPayloads[K] };
}[EventKind];
export type FleetEvent = EventInput & { seq: number };

/** GitHub observations extend the existing fleet snapshot without changing its fold. */
export interface GithubPullRequest extends PullRequest {
  repository: string;
  title: string;
  url: string;
  headRef: string;
  draft: boolean;
  review: "none" | "approved" | "changes_requested" | "review_required";
  checks: { name: string; state: PullRequest["ci"]; runId?: number; runAttempt?: number }[];
  checksComplete: boolean;
}
