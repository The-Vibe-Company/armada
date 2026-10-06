// Normalized data contract read from the tracker (Linear) and the forge
// (GitHub). Every derivation in this package works on these shapes only, so
// adapters can change without touching the fleet rules.

export type StatusType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** Armada shipping detail; never a Linear phase label. */
export const SHIPPING_STAGES = ["review", "ci"] as const;
export type ShippingStage = (typeof SHIPPING_STAGES)[number];
export const isShippingStage = (value: unknown): value is ShippingStage => value === "review" || value === "ci";

export type CiState = "success" | "failure" | "pending" | "none";

/** Values of the "Agent phase" label group (the fleet protocol). */
export const LABEL_PHASES = [
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
  // The owner checks what the worker submitted with \`armada validate\` (THE-885).
  "awaiting-validation",
] as const;

export type LabelPhase = (typeof LABEL_PHASES)[number];

/** Label phases plus the states only a status line or a merged PR can express. */
export type AgentPhase = LabelPhase | "released" | "merged";

export interface PullRequest {
  files?: ChangedFile[] | null;
  additions?: number | null;
  deletions?: number | null;
  filesComplete?: boolean;
  checksComplete?: boolean;
  mergeability?: "clean" | "behind" | "conflicting" | "unknown";
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

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
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
  coordinator?: string | null;
  runtime: string | null;
  session: string | null;
  branch: string | null;
  startedAt: string | null;
  /** Conductor profile the worker runs on, when the claim names one (`armada claim --profile`). */
  profile?: string | null;
  profileReason?: string | null;
  at: string;
  author: string | null;
}

export interface Comment {
  id: string;
  issueId: string;
  author: string | null;
  createdAt: string;
  excerpt: string;
  /**
   * Parsed first line "Agent status: <phase> — <summary>", if present; `plan`
   * when the comment carries a plan block (`armada report --plan`).
   */
  status: { phase: AgentPhase; summary: string; plan?: true } | null;
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

/** A default-branch commit, newest first in the forge reading. */
export interface MainCommit {
  branch: string;
  sha: string;
  at: string;
  headline: string;
  ci: CiState;
  checks: { name: string; state: CiState }[];
  /** False when GitHub truncated the check contexts. */
  checksComplete?: boolean;
}

export interface MainHealth {
  branch: string;
  /** Actual branch tip, including an unchecked release commit. */
  head: string;
  /** State of the newest commit that ran checks; none when no commit did. */
  state: "green" | "red" | "running" | "none";
  redSince: { sha: string; pr: number | null; at: string; failing: string[] } | null;
  fixRunning: { sha: string; pr: number | null } | null;
  /** The oldest observed red is a lower bound; the start lies beyond the history window. */
  redBeyondWindow: boolean;
}

/** Everything read from the forge for one repository. */
export interface ForgeData {
  repo: string;
  fetchedAt: string;
  /** Open pull requests and recently closed ones. */
  prs: PullRequest[];
  /** False when the open pull request listing was truncated. */
  openPrsComplete?: boolean;
  /** Absent in snapshots written before default-branch health was read. */
  main?: MainCommit[];
  /** True when the history reached the repository's first commit. */
  mainComplete?: boolean;
  warnings: string[];
}
