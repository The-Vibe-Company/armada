"use server";

import type { SandboxProviderId } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient } from "@/lib/control";
import { explainSetupError } from "@/lib/data/provider-setup";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer, type Viewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  isConfigured,
  isSetupProvider,
  parseProviderStatus,
  providerSetupValue,
  SETUP_PROVIDER_INFO,
  safeConnectMessage,
} from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

/**
 * Connects, or replaces, one of the selected organization's sandbox providers (`org/provider/connect`): an admin's
 * Boat key or Modal token, which the server checks with the provider before storing it encrypted for the
 * organization. A refused value is never stored, so a rejected replacement leaves the connected key in place. One
 * request, never retried; the value is not kept, logged or shown again. Done only when the server's own status
 * confirms the provider.
 */
export async function connectProvider(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const checked = await adminRequest(data);
  if (!checked.ok) return checked.result;
  const { viewer, org, provider } = checked;
  const replacing = formString(data, "mode") === "replace";
  const fields = {
    boatKey: data.get("boat_key"),
    modalTokenId: data.get("modal_token_id"),
    modalTokenSecret: data.get("modal_token_secret"),
  };
  const value = providerSetupValue(provider, fields);
  if (!value.ok) return fail(value.error);
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");

  let result: unknown;
  try {
    result = await createControlClient({ serverUrl, token: viewer.token }).post("org/provider/connect", {
      org,
      provider,
      value: value.value,
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    const typed = [value.value, ...Object.values(fields).map((item) => (typeof item === "string" ? item.trim() : ""))];
    const message = safeConnectMessage(explainSetupError(error), typed);
    return fail(replacing ? `${message} The connected ${keyNoun(provider)} is unchanged.` : message);
  }
  const status = parseProviderStatus(result, org);
  if (!status?.ready || !isConfigured(status, provider))
    return fail("The Armada server did not confirm the connection. Reload this page to check before trying again.");
  revalidatePath("/", "layout");
  const label = SETUP_PROVIDER_INFO[provider].label;
  return done(replacing ? `${label} ${keyNoun(provider)} replaced.` : `${label} connected.`);
}

/**
 * Disconnects one of the selected organization's sandbox providers (`org/provider/disconnect`, which checks the admin
 * role again). Goldens and sandboxes already on it stay listed and manageable; new builds, rebuilds and launches on
 * it stop until it is connected again.
 */
export async function disconnectProvider(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const checked = await adminRequest(data);
  if (!checked.ok) return checked.result;
  const { viewer, org, provider } = checked;
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  let result: unknown;
  try {
    result = await createControlClient({ serverUrl, token: viewer.token }).post("org/provider/disconnect", {
      org,
      provider,
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(explainSetupError(error));
  }
  const status = parseProviderStatus(result, org);
  if (!status || isConfigured(status, provider))
    return fail("The Armada server did not confirm the change. Reload this page to check before trying again.");
  revalidatePath("/", "layout");
  return done(`${SETUP_PROVIDER_INFO[provider].label} disconnected.`);
}

/** The form's organization is the selected one and the viewer administers it (the server checks both again). */
async function adminRequest(
  data: FormData,
): Promise<
  { ok: true; viewer: Viewer; org: string; provider: SandboxProviderId } | { ok: false; result: ActionResult }
> {
  const viewer = await requireViewer();
  const org = formString(data, "org");
  const provider = formString(data, "provider");
  if (!isUuid(org) || !isSetupProvider(provider)) return { ok: false, result: fail("That request is not valid.") };
  if (!(await isSelectedOrganization(org))) return { ok: false, result: fail("Switch to that organization first.") };
  const membership = (await listMemberships(await createClient(), viewer.id)).find((item) => item.org.id === org);
  if (membership?.role !== "admin")
    return { ok: false, result: fail("Only an admin of this organization manages its sandbox providers.") };
  return { ok: true, viewer, org, provider };
}

function keyNoun(provider: SandboxProviderId): string {
  return provider === "boat" ? "key" : "token";
}
