import { DOCKER_HOST_DRAINING_MESSAGE } from "./docker-host-drain.ts";
import { providerRateLimitMessage } from "./provider-limit.ts";
/** Closed failure categories shared by HTTP, MCP and API consumers. Legacy `unavailable` is not emitted. */
export const API_FAILURE_STATUS = {
  provider_routing_unavailable: 503,
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
  provider_routing_unavailable:
    "Sandbox launch is unavailable because the server provider setup is incomplete. Ask the Armada administrator to finish provider setup, then retry.",
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

/** Closed launch guidance; never relay provider or guest diagnostics. Typed causes precede HTTP fallback. */
const LAUNCH_FAILURE_HELP: Record<string, string> = {
  provider_not_configured:
    "The agent has no subscription or API key. Add a model account or choose another agent, then launch again.",
  no_credentials:
    "Sandbox launch needs a GitHub connection for the configured repository. Connect GitHub with repository read access, then retry.",
  invalid_request: "The launch settings were refused. Check the selected snapshot, model and account, then retry.",
  unsupported: "The selected launch configuration is unsupported. Choose a supported agent and provider, then retry.",
  start_failed: "The sandbox could not start. Check its recorded status, correct the provider setup and launch again.",
  init_failed:
    "Sandbox initialization failed. Check the repository and initialization commands, correct them and launch again.",
  prompt_failed:
    "The sandbox started but its first prompt was refused. Check the sandbox and model account before sending the prompt again.",
  host_full:
    "The selected host has no free sandbox slots. Stop a sandbox or ask its administrator to raise the limit, then retry.",
  host_draining: DOCKER_HOST_DRAINING_MESSAGE,
  payment_required:
    "The provider account cannot create machines. Check billing or credits on the selected provider account before retrying.",
};
export function launchFailureHelp(
  code: string | undefined,
  details?: unknown,
  publicMessage?: string,
): string | undefined {
  if (!code) return undefined;
  // Request validation messages are authored by Armada, not provider or guest diagnostics.
  if (["invalid_request", "unsupported", "no_credentials"].includes(code) && publicMessage) return publicMessage;
  if (code === "rate_limited") return providerRateLimitMessage(details);
  if (Object.hasOwn(LAUNCH_FAILURE_HELP, code)) return LAUNCH_FAILURE_HELP[code];
  if (Object.hasOwn(API_FAILURE_HELP, code)) return API_FAILURE_HELP[code as ApiFailureCode];
  return undefined;
}
