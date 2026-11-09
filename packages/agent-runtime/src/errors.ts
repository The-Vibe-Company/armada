export type HarnessErrorCode =
  | "authentication_failed"
  | "usage_limit_exceeded"
  | "rate_limited"
  | "context_window_exceeded"
  | "harness_failed"
  | "harness_process_lost"
  | "harness_timeout"
  | "invalid_harness_protocol";
export class HarnessError extends Error {
  constructor(readonly code: HarnessErrorCode) {
    super(code);
  }
}
