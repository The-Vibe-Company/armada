import { type ControlClient, ControlError } from "./control.ts";
import { type ProviderStatus, parseProviderStatus } from "./provider-setup.ts";

/**
 * An organization's provider setup for this request: `ready` (new goldens and launches may start), `pending` (the
 * organization holds no provider credential yet) or `unavailable` (the server could not be asked, or answered
 * something unexpected; a retryable error, never treated as either of the others).
 */
export type ProviderSetup =
  | { state: "ready" | "pending"; status: ProviderStatus }
  | { state: "unavailable"; message: string };

const UNSUPPORTED = "This Armada server does not offer organization provider setup yet.";
const TEMPORARY = "The Armada server could not be reached just now. Check again in a moment.";
const UNCONFIRMED =
  "Provider setup could not be confirmed. Reload Providers to check its current state before trying again.";

/** Asks `org/provider/status` once. Any failure is `unavailable`: a missing status never counts as configured. */
export async function readSetupWith(client: ControlClient, org: string): Promise<ProviderSetup> {
  let result: unknown;
  try {
    result = await client.post("org/provider/status", { org });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { state: "unavailable", message: explainSetupError(error) };
  }
  const status = parseProviderStatus(result, org);
  if (!status) return { state: "unavailable", message: "The Armada server sent an unexpected answer." };
  return { state: status.ready ? "ready" : "pending", status };
}

/**
 * A control error in words about provider setup (the client's timeout text speaks of golden builds). Only the Armada
 * server's own answer that it has no such route means "unsupported": `unknown_route`, the legacy control router's
 * `not_found` "Unknown route." or its top-level `{ "error": "not_found" }`. A 404 without these (an edge or proxy page while no deployment
 * serves, an unreadable body) is a temporary outage, never a missing capability.
 */
export function explainSetupError(error: ControlError, replacingNoun?: string): string {
  if (error.outcomeUnknown) return UNCONFIRMED;
  if (error.status === undefined && error.message.startsWith("The Armada server did not answer in time"))
    return "The Armada server did not answer in time. Reload this page before trying again.";
  if (error.status === 404) {
    const unknownRoute =
      error.code === "unknown_route" ||
      (error.code === "not_found" && error.message === "Unknown route.") ||
      (error.code === undefined && error.message === "not_found");
    if (unknownRoute) return UNSUPPORTED;
    if (error.code === undefined) return TEMPORARY;
  }
  if (error.status === 400)
    return `The provider credentials were not accepted. Check them in your provider account, then try again.${replacingNoun ? ` The connected ${replacingNoun} is unchanged.` : ""}`;
  if (error.status === 401) return "Your session ended. Sign in again, then reload Providers.";
  if (error.status === 403)
    return "Only an organization admin manages providers. Reload Providers to check your access.";
  if (error.status === 404)
    return "This organization is no longer available. Reload Providers and choose an organization.";
  if (error.status === 409) return "Provider setup changed. Reload Providers before trying again.";
  return UNCONFIRMED;
}
