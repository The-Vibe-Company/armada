import { capabilities } from "./machine-capabilities.ts";
import { isSandboxPlacementProvider } from "./sandbox-provider.ts";

/** Refuse before queue admission, capacity reservation or provider access. */
export function sandboxControlRefusal(
  sandbox: {
    provider: string;
    status: string;
    statusReason?: string | null;
    expiresAt?: string | null;
    boatRuntime?: boolean;
    modalTransport?: string | null;
    preservationNote?: string | null;
  },
  now: Date,
  operation = "send",
): string | null {
  const expired =
    (sandbox.status === "stopped" && sandbox.statusReason === "expired") ||
    (!!sandbox.expiresAt && new Date(sandbox.expiresAt).getTime() <= now.getTime());
  const machine = isSandboxPlacementProvider(sandbox.provider) ? capabilities(sandbox.provider) : undefined;
  // Idle suspension and merge stops can wake through a retained checkpoint.
  const retained = sandbox.statusReason === "idle_paused" || sandbox.statusReason === "work_merged";
  const stoppedWithWork =
    sandbox.status === "stopped" && !expired && sandbox.preservationNote !== "checkpoint_failed_disk_not_retained";
  const canWake =
    stoppedWithWork &&
    sandbox.statusReason !== "agent_finished" &&
    (retained || (machine?.resumeAfterStop && (machine.stopRetention !== "container" || sandbox.statusReason == null)));
  if (operation === "send" && canWake) return null;
  if (!expired && !["stopped", "failed", "expired", "deleted", "removed"].includes(sandbox.status)) return null;
  const reason = expired ? "expired" : sandbox.status;
  const prefix = `Cannot control ${sandbox.provider} sandbox: ${reason}. `;
  if (machine?.stopRetention === "container") {
    if (stoppedWithWork && retained)
      return `${prefix}Send a message to resume its retained idle checkpoint before using this operation.`;
    if (canWake)
      return `${prefix}Send a message to resume its retained workspace; start a new sandbox on the same branch if recovery is unavailable.`;
    return `${prefix}Its container is removed after finish/stop; start a new sandbox on the same branch.`;
  }
  if (stoppedWithWork && machine?.resumeAfterStop)
    return `${prefix}Send a message to resume its preserved work; start a new sandbox on the same branch if recovery is unavailable.`;
  if (sandbox.boatRuntime || sandbox.modalTransport === "dialout")
    return `${prefix}Use runtime_resume with a synchronized retained checkpoint if available; otherwise start a new sandbox on the same branch.`;
  return `${prefix}This operation cannot resume it; start a new sandbox on the same branch. Retained idle pauses wake automatically on send before expiry.`;
}
