export type HarnessErrorCode =
  | "model_unavailable"
  | "session_restore_failed"
  | "model_selection_failed"
  | "session_start_failed"
  | "turn_start_failed"
  | "harness_initialization_failed"
  | "authentication_failed"
  | "usage_limit_exceeded"
  | "rate_limited"
  | "context_window_exceeded"
  | "output_limit_exceeded"
  | "harness_failed"
  | "harness_process_lost"
  | "harness_timeout"
  | "invalid_harness_protocol";
export type NativePhase =
  | "authentication"
  | "session_restore"
  | "model_selection"
  | "session_start"
  | "turn_start"
  | "initialization";

export class HarnessError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    readonly phase?: NativePhase,
  ) {
    super(code);
  }

  get reason(): string {
    return this.phase ? `${this.code}:${this.phase}` : this.code;
  }
}

// Only structured discriminants are inspected. Native messages, data payloads and stderr
// must never become public reasons, even when the upstream error is unrecognized.
export function nativeHarnessError(error: unknown, method: string, protocol?: "acp"): HarnessError {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const root = record(error);
  const data = record(root.data);
  const codes = [root.code, root.type, root.name, root.status, data.code, data.type];
  const has = (...values: unknown[]) => codes.some((code) => values.includes(code));
  const code: HarnessErrorCode =
    (protocol === "acp" && root.code === -32000) ||
    has(
      401,
      403,
      "unauthorized",
      "authentication_failed",
      "cloud_credential_error",
      "AuthenticationError",
      "AuthRequired",
    )
      ? "authentication_failed"
      : has("model_not_found", "model_unavailable", "ModelNotFoundError")
        ? "model_unavailable"
        : has("rateLimitExceeded", "rate_limit", "overloaded", 429)
          ? "rate_limited"
          : has("usageLimitExceeded", "sessionBudgetExceeded")
            ? "usage_limit_exceeded"
            : has("contextWindowExceeded")
              ? "context_window_exceeded"
              : has("max_output_tokens")
                ? "output_limit_exceeded"
                : method === "account/login/start" || method === "authenticate"
                  ? "authentication_failed"
                  : method === "thread/resume" || method === "session/load"
                    ? "session_restore_failed"
                    : method === "session/set_model"
                      ? "model_selection_failed"
                      : method === "thread/start" || method === "session/new"
                        ? "session_start_failed"
                        : method === "turn/start" || method === "session/prompt"
                          ? "turn_start_failed"
                          : method === "initialize"
                            ? "harness_initialization_failed"
                            : "harness_failed";
  const phase: NativePhase | undefined =
    method === "account/login/start" || method === "authenticate"
      ? "authentication"
      : method === "thread/resume" || method === "session/load"
        ? "session_restore"
        : method === "session/set_model"
          ? "model_selection"
          : method === "thread/start" || method === "session/new"
            ? "session_start"
            : method === "turn/start" || method === "session/prompt"
              ? "turn_start"
              : method === "initialize"
                ? "initialization"
                : undefined;
  return new HarnessError(code, phase);
}

/**
 * ACP v1 stop reasons. Only `end_turn` is a completed turn; `max_tokens` is the model's
 * output limit, not a configuration failure. Unknown reasons stay generic.
 */
export function acpStopReasonCode(stopReason: unknown): "finished" | "interrupted" | HarnessErrorCode {
  if (stopReason === "end_turn") return "finished";
  if (stopReason === "cancelled") return "interrupted";
  if (stopReason === "max_tokens") return "output_limit_exceeded";
  return "harness_failed";
}
