// Normalized data contract read from the tracker (Linear) and the forge
// (GitHub). Every derivation in this package works on these shapes only, so
// adapters can change without touching the fleet rules.

export type StatusType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

export type CiState = "success" | "failure" | "pending" | "none";

/** Values of the "Agent phase" label group (the fleet protocol). */
export const LABEL_PHASES = [
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
] as const;

export type LabelPhase = (typeof LABEL_PHASES)[number];

/** Label phases plus the states only a status line or a merged PR can express. */
export type AgentPhase = LabelPhase | "released" | "merged";

export interface PullRequest {
  url: string;
  number: number;
  /** owner/name */
  repo: string;
  title: string;
  /** Forge enrichment; absent when the forge was not read. */
  state?: "open" | "merged" | "closed";
  draft?: boolean;
  ci?: CiState;
  checks?: { name: string; state: CiState }[];
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRef?: string;
  headSha?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
}

/** A tracker issue this issue is blocked by, with the state it had when read. */
export interface Blocker {
  id: string;
  statusType: StatusType;
}

export interface Issue {
  /** Human identifier, e.g. ABC-12. */
  id: string;
  /** Tracker-internal id, used to query comments. */
  uuid: string;
  title: string;
  url: string;
  status: string;
  statusType: StatusType;
  assignee: string | null;
  delegate: string | null;
  labels: string[];
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  agentPhase: LabelPhase | null;
  agentRuntime: string | null;
  blockedBy: Blocker[];
  /** Pull requests linked from the tracker (attachments or URLs in the description). */
  prs: PullRequest[];
}

export interface AgentClaim {
  runtime: string | null;
  session: string | null;
  branch: string | null;
  startedAt: string | null;
  /** Conductor profile the worker runs on, when the claim names one (`armada claim --profile`). */
  profile?: string | null;
  at: string;
  author: string | null;
}

export interface Comment {
  id: string;
  issueId: string;
  author: string | null;
  createdAt: string;
  excerpt: string;
  /** Parsed first line "Agent status: <phase> — <summary>", if present. */
  status: { phase: AgentPhase; summary: string } | null;
  /** Parsed "Agent claim — runtime: … · session: … · branch: … · started: …". */
  claim: AgentClaim | null;
}

/** Everything read from the tracker for one program. */
export interface ProgramData {
  rootId: string;
  fetchedAt: string;
  /** Root and every descendant, any depth. */
  issues: Issue[];
  comments: Comment[];
  /** Reads cut short by a cap: the report may be incomplete where these say. */
  warnings: string[];
}

/** Everything read from the forge for one repository. */
export interface ForgeData {
  repo: string;
  fetchedAt: string;
  /** Open pull requests and recently closed ones. */
  prs: PullRequest[];
  warnings: string[];
}
