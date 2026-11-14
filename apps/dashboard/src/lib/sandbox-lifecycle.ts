/** Lifecycle responses may be lost after mutation. Never present provider diagnostics or imply a confirmed refusal. */
export function lifecycleFailure(operation: "stop" | "delete", error: { status?: number | undefined }): string {
  if (error.status === 401 || error.status === 403)
    return "This session cannot manage the sandbox. Sign in again, or ask an organization admin to check your access.";
  return operation === "stop"
    ? "The stop request could not be confirmed. Reload this sandbox to check its current state before trying again."
    : "The delete request could not be confirmed. Reload the sandbox list to check whether it was removed before trying again.";
}
