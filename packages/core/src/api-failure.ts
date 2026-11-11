/** Closed failure categories shared by HTTP, MCP and API consumers. Legacy `unavailable` is not emitted. */
export const API_FAILURE_STATUS = {
  github_hydration_failed: 503,
  extension_not_found: 404,
  extension_not_allowed: 403,
  extension_state: 409,
  extension_maximum: 400,
  credential_refused: 422,
  provider_unavailable: 502,
  dependency_unavailable: 503,
  outcome_unknown: 503,
} as const;
export type ApiFailureCode = keyof typeof API_FAILURE_STATUS;
export const API_FAILURE_HELP: Record<ApiFailureCode, string> = {
  github_hydration_failed:
    "GitHub repair could not install private credentials. Check the failing phase (SSH, sudo, filesystem or token write), correct it and retry refresh.",
  extension_not_found: "Sandbox not found or not accessible.",
  extension_not_allowed: "You are not allowed to extend this sandbox.",
  extension_state: "Sandbox cannot be extended in this state or to this deadline. Refresh status.",
  extension_maximum: "Requested lifetime exceeds the provider maximum.",
  credential_refused:
    "The account credential was refused, revoked or expired. Replace or reconnect it before retrying.",
  provider_unavailable: "The sandbox provider is temporarily unavailable. Try again later.",
  dependency_unavailable: "An Armada server dependency is unavailable. Try again later.",
  outcome_unknown: "The operation outcome is unknown. Check its status before retrying; it may already have started.",
};

/** Only these protocol phases may leave the private SSH transport. */
const GITHUB_HYDRATION_PHASES = [
  "ssh",
  "privilege",
  "payload",
  "directories",
  "lock",
  "executables",
  "install",
  "token_write",
  "sudo",
  "bootstrap",
] as const;
export type GitHubHydrationPhase = (typeof GITHUB_HYDRATION_PHASES)[number];
export function githubHydrationPhase(value: unknown): GitHubHydrationPhase | undefined {
  return typeof value === "string" && GITHUB_HYDRATION_PHASES.includes(value as GitHubHydrationPhase)
    ? (value as GitHubHydrationPhase)
    : undefined;
}

/** Fixed-message failure; only an allowlisted phase, never guest diagnostics, is public. */
export class GitHubHydrationError extends Error {
  readonly details: Readonly<{ phase: GitHubHydrationPhase }>;
  constructor(phase: unknown = "ssh") {
    super(API_FAILURE_HELP.github_hydration_failed);
    this.details = Object.freeze({ phase: githubHydrationPhase(phase) ?? "ssh" });
  }
}
