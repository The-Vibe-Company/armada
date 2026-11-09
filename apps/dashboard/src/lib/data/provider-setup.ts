import type { SandboxProviderId } from "@armada/core";
import { cache } from "react";
import { CAPABILITIES_TIMEOUT_MS, createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { isConfigured, SETUP_PROVIDER_INFO } from "@/lib/provider-setup";
import { type ProviderSetup, readSetupWith } from "@/lib/provider-setup-read";
import { requireViewer } from "./viewer";

export type { ProviderSetup } from "@/lib/provider-setup-read";
export { explainSetupError } from "@/lib/provider-setup-read";

/** One read per organization and request (`org/provider/status`), never retried. */
export const readProviderSetup = cache(async (org: string): Promise<ProviderSetup> => {
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token)
    return { state: "unavailable", message: "The Armada server is not configured for this dashboard." };
  return readSetupWith(
    createControlClient({ serverUrl, token: viewer.token, timeoutMs: CAPABILITIES_TIMEOUT_MS }),
    org,
  );
});

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
