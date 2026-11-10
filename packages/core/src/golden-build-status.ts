import type { GoldenBuildWarning } from "./golden-build-warning.ts";
export interface GoldenBuildStatus {
  jobId: string;
  /** Provider of the admitted immutable target; absent only in older server replies. */
  provider?: "boat" | "modal";
  state: "queued" | "running" | "recovery_required" | "succeeded" | "failed";
  phase: string;
  failureReason?: "skillpack_integrity_failed" | null;
  errorCode: "build_failed" | null;
  result: { name: string; visibility: "org" | "private"; snapshot: string; warnings?: GoldenBuildWarning[] } | null;
}
