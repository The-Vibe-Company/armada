export interface GoldenBuildStatus {
  jobId: string;
  state: "queued" | "running" | "recovery_required" | "succeeded" | "failed";
  phase: string;
  errorCode: "build_failed" | null;
  result: { name: string; visibility: "org" | "private"; snapshot: string } | null;
}
