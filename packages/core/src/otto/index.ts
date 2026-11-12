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
