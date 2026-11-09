import type { SandboxProviderId } from "@armada/core";
import { cache } from "react";
import { CAPABILITIES_TIMEOUT_MS, ControlError, createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { isConfigured, type ProviderStatus, parseProviderStatus, SETUP_PROVIDER_INFO } from "@/lib/provider-setup";
import { requireViewer } from "./viewer";

/**
 * An organization's provider setup for this request: `ready` (new goldens and launches may start), `pending` (the
 * organization holds no provider credential yet) or `unavailable` (the server could not be asked, or answered
 * something unexpected; a retryable error, never treated as either of the others).
 */
export type ProviderSetup =
  | { state: "ready" | "pending"; status: ProviderStatus }
  | { state: "unavailable"; message: string };

/** One read per organization and request (`org/provider/status`), never retried. */
export const readProviderSetup = cache(async (org: string): Promise<ProviderSetup> => {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token)
    return { state: "unavailable", message: "The Armada server is not configured for this dashboard." };
  let result: unknown;
  try {
    result = await createControlClient({ serverUrl, token: viewer.token, timeoutMs: CAPABILITIES_TIMEOUT_MS }).post(
      "org/provider/status",
      { org },
    );
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { state: "unavailable", message: explainSetupError(error) };
  }
  const status = parseProviderStatus(result, org);
  if (!status) return { state: "unavailable", message: "The Armada server sent an unexpected answer." };
  return { state: status.ready ? "ready" : "pending", status };
});

/** A control error in words about provider setup (the client's timeout text speaks of golden builds). */
export function explainSetupError(error: ControlError): string {
  if (error.status === undefined && error.message.startsWith("The Armada server did not answer in time"))
    return "The Armada server did not answer in time. Reload this page before trying again.";
  if (error.status === 404 && error.code === undefined)
    return "This Armada server does not offer organization provider setup yet.";
  return error.message;
}

/**
 * Why new work (a golden build, a rebuild, a launch) cannot start on this provider in this organization, or null when
 * it can. Only the organization's own connection of that exact provider counts: another connected provider or a
 * personal key does not. Checked by the server actions themselves, so a forged form post meets the same rule as the
 * page. A status that could not be read is a retryable error, never "not connected".
 */
export async function newWorkBlocker(org: string, provider: SandboxProviderId): Promise<string | null> {
  const setup = await readProviderSetup(org);
  if (setup.state === "unavailable")
    return `The organization's sandbox providers could not be checked. ${setup.message}`;
  if (isConfigured(setup.status, provider)) return null;
  const label = SETUP_PROVIDER_INFO[provider].label;
  return `${label} is not connected for this organization. An admin connects it in Settings.`;
}
