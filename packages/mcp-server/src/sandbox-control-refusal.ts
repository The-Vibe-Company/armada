/** Refuse before queue admission, capacity reservation or provider access. */
export function sandboxControlRefusal(
  sandbox: {
    provider: string;
    status: string;
    statusReason?: string | null;
    expiresAt?: string | null;
    boatRuntime?: boolean;
    runtimeTransport?: string | null;
  },
  now: Date,
): string | null {
  const expired = !!sandbox.expiresAt && new Date(sandbox.expiresAt).getTime() <= now.getTime();
  // Idle suspension is an intentional retained-compute wake path, not a finished sandbox.
  if (sandbox.status === "stopped" && sandbox.statusReason === "idle_paused" && !expired) return null;
  if (!expired && !["stopped", "failed", "expired", "deleted", "removed"].includes(sandbox.status)) return null;
  const reason = expired ? "expired" : sandbox.status;
  const prefix = `Cannot control ${sandbox.provider} sandbox: ${reason}. `;
  if (sandbox.provider === "docker")
    return `${prefix}Its container is removed after finish/stop; start a new sandbox on the same branch.`;
  if (sandbox.boatRuntime || sandbox.runtimeTransport === "dialout")
    return `${prefix}Use runtime_resume with a synchronized retained checkpoint if available; otherwise start a new sandbox on the same branch.`;
  return `${prefix}This operation cannot resume it; start a new sandbox on the same branch. Retained idle pauses wake automatically on send before expiry.`;
}
