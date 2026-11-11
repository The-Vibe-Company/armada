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

/** Closed provider names only; never interpolate an upstream error payload. */
export function providerPaymentRequiredMessage(provider?: "boat" | "modal"): string {
  const name = provider === "boat" ? "Boat" : provider === "modal" ? "Modal" : "the provider";
  return `The ${name === "the provider" ? "provider" : name} account cannot create machines: add billing or credits on ${name}, then retry.`;
}

/** Recovery retains capacity, so never advise a retry until the build is failed. */
export function goldenBuildFailureText(status: GoldenBuildStatus): string {
  if (status.state === "recovery_required")
    return "Recovery required; capacity is still held. Contact an operator or administrator to reconcile the original build before retrying.";
  return status.state === "failed" && status.failureReason === "provider_payment_required"
    ? providerPaymentRequiredMessage(status.provider)
    : (status.failureReason ?? "build_failed");
}
