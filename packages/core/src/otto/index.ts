/** Observations are evidence, never commands or task-completion declarations. */
export type OttoTruth = "true" | "false" | "unknown";
export type OttoCompleteness = "complete" | "partial" | "unknown";
export interface OttoFact {
  id: string;
  org_id: string;
  repository: string;
  subject: string;
  kind: string;
  value: OttoTruth;
  observed_at: string;
  source: string;
  source_id: string;
  completeness: OttoCompleteness;
  evidence: Record<string, unknown>;
}
export interface OttoPage<T> {
  items: T[];
  observedAt: string | null;
  completeness: OttoCompleteness;
  nextCursor: string | null;
}
export interface OttoResource {
  kind: "pr" | "sandbox";
  externalId: string;
  taskIssue: number | null;
  owner: {
    state: "owned" | "candidate" | "orphan" | "unknown";
    userId: string | null;
    sandboxId?: string;
    candidateSandboxIds?: string[];
    confirmation?: "confirmed" | "candidate";
  };
  activity?: { state: "live" | "idle" | "not_live" | "unknown"; observedAt: string | null; since?: string | null };
  needsWork?: OttoTruth;
  reason: string;
  observedAt: string | null;
  evidence: Record<string, unknown>;
}
export interface OttoTask {
  issueNumber: number;
  title: string;
  state: "open" | "unknown";
  factId: string | null;
}
export interface OttoOrphan {
  resource: OttoResource;
  state: "orphan" | "unknown";
  reason: string;
  day: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  current?: boolean | null;
}
