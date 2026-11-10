import type { GoldenBuildWarning } from "./golden-build-warning.ts";
export interface GoldenBuildStatus {
  jobId: string;
  /** Provider of the admitted immutable target; absent only in older server replies. */
  provider?: "boat" | "modal";
  state: "queued" | "running" | "recovery_required" | "succeeded" | "failed";
  phase: string;
  failureReason?: "skillpack_integrity_failed" | "provider_payment_required" | null;
  errorCode: "build_failed" | null;
  result: { name: string; visibility: "org" | "private"; snapshot: string; warnings?: GoldenBuildWarning[] } | null;
}

/** Closed remediation, safe for every client surface. */
export const PROVIDER_PAYMENT_REQUIRED_MESSAGE = "The provider account cannot create machines: add billing or credits on the provider, then retry.";
