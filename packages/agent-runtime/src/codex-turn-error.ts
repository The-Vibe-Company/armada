import type { HarnessErrorCode } from "./errors.ts";

/**
 * Pinned Codex 0.167.0 reports a response cut by the model's output limit as a generic
 * `other` terminal error. Its Display text is the only discriminant, so match the exact
 * closed literal and never publish it. Any other `other` error stays a generic failure.
 */
const OUTPUT_LIMIT_MESSAGE = "Incomplete response returned, reason: max_output_tokens";

/** Map a Codex terminal error to the closed Armada reason without exposing native text. */
export function codexTurnFailureCode(code: string | undefined, message: string | undefined): HarnessErrorCode {
  if (code === "unauthorized") return "authentication_failed";
  if (code === "usageLimitExceeded" || code === "sessionBudgetExceeded") return "usage_limit_exceeded";
  if (code === "rateLimitExceeded") return "rate_limited";
  if (code === "contextWindowExceeded") return "context_window_exceeded";
  if (code === "other" && message === OUTPUT_LIMIT_MESSAGE) return "output_limit_exceeded";
  return "harness_failed";
}
