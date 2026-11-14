/** Mechanical observations are not objective completion or human approval. */
export interface OttoMechanicalEvidence {
  repository: string;
  number: number;
  headSha: string | null;
  observedAt: string | null;
  requiredChecks: "success" | "pending" | "failure" | "unknown";
  merged: boolean | null;
  checks: { name: string; state: string }[];
  mergeState: "conflicting" | "mergeable" | "unknown";
  deployment: "unknown";
  evidence: { factId: string; kind: string; observedAt: string; url: string }[];
  limits: string[];
}
