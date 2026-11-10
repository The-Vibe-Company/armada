/** Closed failure categories shared by HTTP, MCP and API consumers. Legacy `unavailable` is not emitted. */
export const API_FAILURE_STATUS = {
  credential_refused: 422,
  provider_unavailable: 502,
  dependency_unavailable: 503,
  outcome_unknown: 503,
} as const;
export type ApiFailureCode = keyof typeof API_FAILURE_STATUS;
export const API_FAILURE_HELP: Record<ApiFailureCode, string> = {
  credential_refused:
    "The account credential was refused, revoked or expired. Replace or reconnect it before retrying.",
  provider_unavailable: "The sandbox provider is temporarily unavailable. Try again later.",
  dependency_unavailable: "An Armada server dependency is unavailable. Try again later.",
  outcome_unknown: "The operation outcome is unknown. Check its status before retrying; it may already have started.",
};
