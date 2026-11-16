/** Lifecycle responses may be lost after mutation. Keep definite refusals separate from transport uncertainty. */
export function lifecycleFailure(
  operation: "stop" | "delete",
  error: { status?: number | undefined; code?: string | undefined },
): string {
  if (error.status === 401 || error.status === 403)
    return "This session cannot manage the sandbox. Sign in again, or ask an organization admin to check your access.";
  if (error.code === "not_found" || error.status === 404)
    return `The sandbox could not be ${operation === "stop" ? "stopped" : "deleted"} because it was not found. Reload the sandbox list to check your access and selection.`;
  // Conflict may mean the provider accepted deletion but has not finished it.
  if (
    error.code !== "conflict" &&
    error.status !== 409 &&
    (error.code === "invalid" ||
      error.code === "invalid_request" ||
      (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408))
  )
    return `The ${operation} request was refused because it was not accepted by the server. Reload the sandbox and check your selection before trying again.`;
  return operation === "stop"
    ? "The stop request could not be confirmed. Reload this sandbox to check its current state before trying again."
    : "The delete request could not be confirmed. Reload the sandbox list to check whether it was removed before trying again.";
}
