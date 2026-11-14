import { type GoldenBuildStatus, SANDBOX_PLACEMENT_LABELS, type SandboxProviderId } from "@armada/core";
import type { ActionResult } from "./action";

/** Primary build feedback is value-free; job references belong in Details, not status sentences. */
export function snapshotBuildFeedback(
  build: GoldenBuildStatus,
  mode: "create" | "update",
  requestedProvider?: SandboxProviderId | null,
): ActionResult {
  if (build.state === "recovery_required")
    return {
      ok: false,
      error:
        "This build needs administrator recovery. Capacity is still reserved. Ask an administrator to check this build before starting another.",
    };
  if (build.state === "failed") {
    if (
      build.phase === "queued" &&
      build.failureReason ===
        "detail:Build cancelled by its owner before a builder started. Start a new build request when ready."
    )
      return {
        ok: true,
        message: "Queued build cancelled. No builder was started. Start a new build request when ready.",
      };
    let error = "The snapshot build did not complete. Ask an administrator to inspect its status before trying again.";
    if (build.failureReason === "provider_payment_required")
      error = "The provider account needs billing or credits. Check Providers before starting another build.";
    else if (build.failureReason === "provider_snapshot_rejected")
      error =
        "The provider could not save the snapshot. Check its billing, limits and snapshot availability before starting another build.";
    else if (build.failureReason === "skillpack_integrity_failed")
      error =
        "Private-skill tools could not be verified. Ask an administrator to check the verified package before rebuilding.";
    return { ok: false, error };
  }
  if (build.state === "queued")
    return { ok: true, message: "Snapshot build queued. Waiting for an available builder." };
  if (build.state === "running") return { ok: true, message: "Snapshot build is running." };
  if (!build.result) return { ok: true, message: "The build finished. Reload Snapshots to check its result." };
  const provider = build.provider ?? requestedProvider;
  const where = provider ? `${SANDBOX_PLACEMENT_LABELS[provider]} ` : "";
  return {
    ok: true,
    message: `${mode === "create" ? "Built" : "Rebuilt"} ${where}snapshot '${build.result.name}'. Ready to launch.`,
  };
}
