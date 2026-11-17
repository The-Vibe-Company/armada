import type { SandboxProviderId } from "@armada/core";
import type { ControlError } from "./control";

export const SNAPSHOT_ACTION_UNCONFIRMED =
  "The snapshot action could not be confirmed. Reload Snapshots and check its current state before trying again.";
type SnapshotAction = "build" | "find" | "cancel" | "remove" | "size";
const FEATURES: Record<SnapshotAction, string> = {
  build: "secure snapshot builds",
  find: "finding active snapshot builds",
  cancel: "queued snapshot cancellation",
  remove: "removing snapshots",
  size: "machine size defaults",
};

/** API diagnostics never become display text; unknown replies require observation before resubmission. */
export function snapshotActionFailure(
  error: Pick<ControlError, "status" | "code" | "message" | "outcomeUnknown">,
  action: SnapshotAction,
  provider?: SandboxProviderId,
): string {
  if (error.outcomeUnknown || (error.code === undefined && [502, 503, 504].includes(error.status ?? 0)))
    return action === "build"
      ? "The build may still finish. Reload Snapshots and check its status before trying again."
      : SNAPSHOT_ACTION_UNCONFIRMED;
  const absent =
    error.code === "unknown_route" ||
    ((error.code === "not_found" || error.code === undefined) &&
      ["Unknown route.", "not_found"].includes(error.message));
  if ((error.status === 404 || error.status === 405) && absent)
    return `This Armada server does not offer ${FEATURES[action]} yet. Ask an Armada administrator to finish setup, then reload Snapshots.`;
  if (error.code === "host_draining")
    return "This host is draining for uninstall. Finish or retry the uninstall on the machine; it can take new work again after the uninstall completes or an abandoned drain expires.";
  if (provider === "boat" && action === "build" && error.code === "conflict" && /golden capacity/i.test(error.message))
    return "Snapshot capacity has been reached. Rebuild an existing snapshot or review active builds before creating another.";
  if (error.code === "payment_required")
    return "The provider account needs billing or credits. Check Providers and the build status before trying again.";
  if (error.status === 401) return "Your session ended. Sign in again, then reload Snapshots.";
  if (error.status === 403) {
    if (action === "build")
      return "This build is not allowed. Check organization permissions and your GitHub connection in Settings.";
    if (action === "cancel") return "Only the build owner can cancel it. Reload Snapshots to check your access.";
    return "You cannot change this snapshot with the current access. Ask its owner or an organization admin for help.";
  }
  if (error.status === 404)
    return "This snapshot or build is not available. Reload Snapshots to check its current state.";
  if (error.status === 400)
    return "The snapshot settings were not accepted. Check the form and repository access before trying again.";
  if (error.status === 409)
    return action === "cancel"
      ? "The build is no longer confirmed as queued. Check build status before trying again; only queued work can be cancelled."
      : "This snapshot or build changed. Reload Snapshots and check active work before trying again.";
  return SNAPSHOT_ACTION_UNCONFIRMED;
}
