/** Sandbox command failures may contain guest secrets; only closed reasons leave the client. */
export function sandboxFailure(path: string, status: number, serverCode: unknown, serverMessage: unknown) {
  if (
    !/^\/api\/v1\/sandbox\/(?:list|detail|status|recovery|advice|report|bind-credential|send|steer|interrupt|exec|stop|extend|wait)$/.test(
      path,
    ) &&
    !/^\/api\/v1\/sandboxes\/[0-9a-f-]+(?:\?.*)?$/i.test(path) &&
    path !== "/api/v1/logs/read"
  )
    return undefined;
  if (status === 401) return undefined; // Keep the shared login/token recovery path.
  const inspect = "Run armada list --json to find a visible sandbox ID and check its state and selected organization.";
  const help: Record<string, string> = {
    not_found: `Sandbox not found or not accessible. ${inspect}`,
    forbidden:
      "Sandbox access denied. Check your organization membership and ask the sandbox owner or an org admin for access.",
    invalid_request: `The server rejected the sandbox request. Check arguments with armada COMMAND --help (replace COMMAND with the command you ran). ${inspect}`,
    conflict: `The sandbox state conflicts with this operation. ${inspect} Wait for any start/stop operation to settle before retrying.`,
    sandbox_not_ready: `The sandbox is not ready for this operation. ${inspect} Wait until it is ready before sending another request.`,
    no_running_turn:
      "No turn is running. Check armada status ID; use armada send ID TEXT to start a turn instead of steer.",
    unsupported: `This operation is not supported by the selected sandbox provider or harness. ${inspect}`,
    credential_binding_required:
      "The sandbox needs an account binding. Ask its owner to inspect armada creds list and use armada bind-credential after stopping safely.",
    credential_binding_unsafe:
      "The sandbox account binding cannot be changed safely. Check armada status ID and stop safely before asking its owner to recover the binding.",
    provider_not_configured: "The sandbox provider is not configured. Ask an org admin to check armada org setup.",
    rate_limited:
      "Sandbox request rate limited. Wait before retrying; inspect sandbox state first if this was a mutation.",
  };
  const code =
    status === 404
      ? "not_found"
      : status === 403
        ? "forbidden"
        : typeof serverCode === "string" && Object.hasOwn(help, serverCode)
          ? serverCode
          : status === 400
            ? "invalid_request"
            : status === 409
              ? "conflict"
              : status === 429
                ? "rate_limited"
                : "unavailable";
  // Alias the JSON code emitted before this quality pass; never alias arbitrary server text.
  const wasInterior =
    /^\/api\/v1\/sandbox\/(?:detail|status|send|steer|interrupt|exec|stop|extend|wait)$/.test(path) ||
    path === "/api/v1/logs/read" ||
    path.startsWith("/api/v1/sandboxes/");
  const legacyCode = status === 403 || (wasInterior && status === 404) ? "conflict" : "unavailable";
  // These immutable-binding refusals are fixed server-owned strings, never guest text.
  const bindingReasons: Record<string, string> = {
    "This sandbox is already bound; its account cannot change.":
      "This sandbox is already bound; its account cannot change. Run armada detail ID to inspect the existing binding; keep that account.",
    "The Modal workspace is already bound; its account cannot change.":
      "The Modal workspace is already bound; its account cannot change. Run armada detail ID to inspect the existing binding; keep that account.",
    "The workspace was bound concurrently; no account change was made.":
      "The workspace was bound concurrently; no account change was made. Run armada detail ID to inspect the winning binding before continuing.",
  };
  const bindingReason =
    path === "/api/v1/sandbox/bind-credential" &&
    status === 409 &&
    typeof serverMessage === "string" &&
    Object.hasOwn(bindingReasons, serverMessage)
      ? bindingReasons[serverMessage]
      : undefined;
  return {
    code,
    exitCode: code === "invalid_request" ? (2 as const) : (1 as const),
    message:
      bindingReason ??
      help[code] ??
      `Sandbox operation failed (${status}). Check access and sandbox status. ${inspect} A mutation may already have been accepted; check its outcome before retrying.`,
    legacyCode: code === legacyCode ? undefined : legacyCode,
  };
}
