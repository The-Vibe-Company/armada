import type { GoldenBuildWarning } from "./golden-build-warning.ts";
export interface GoldenBuildStatus {
  jobId: string;
  /** Provider of the admitted immutable target; absent only in older server replies. */
  provider?: "boat" | "modal";
  state: "queued" | "running" | "recovery_required" | "succeeded" | "failed";
  phase: string;
  /** A closed reason code or a bounded diagnostic emitted by trusted build code, never upstream stderr. */
  failureReason?: string | null;
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
  const phase = `Build failed at ${status.phase}`;
  let reason: string;
  if (status.failureReason?.startsWith("detail:")) reason = status.failureReason.slice(7);
  else if (status.failureReason === "provider_snapshot_rejected")
    reason =
      "The provider rejected the saved snapshot request. Check saved-snapshot availability, billing and limits on the provider account.";
  else if (status.failureReason === "provider_payment_required") {
    reason = providerPaymentRequiredMessage(status.provider);
    if (status.state === "recovery_required") reason = reason.replace(", then retry.", ".");
  } else if (status.failureReason === "skillpack_integrity_failed")
    reason = "Skillpack integrity verification failed; rebuild only after the verified package is available.";
  else reason = "The operation did not complete. Ask an administrator to inspect this build's status before retrying.";
  return `${phase}: ${reason}${status.state === "recovery_required" ? " Recovery required; capacity is still held. Contact an operator or administrator to reconcile the original build before retrying." : ""}`;
}
