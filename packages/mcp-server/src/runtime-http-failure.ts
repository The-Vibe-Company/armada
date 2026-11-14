type RuntimeFailureCode =
  | "runtime_command_conflict"
  | "runtime_native_auth_not_supported"
  | "invalid_runtime_events"
  | "runtime_progress_refused"
  | "runtime_model_access_unavailable";

/** Private protocol failures contain only closed codes, never dependency/request diagnostics. */
export function runtimeHttpFailure(status: number, code?: RuntimeFailureCode): Response {
  return Response.json(
    { error: code ?? (status === 401 ? "runtime_enrolment_denied" : "runtime_unavailable") },
    { status, headers: { "cache-control": "no-store" } },
  );
}
