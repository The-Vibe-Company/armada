"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient } from "@/lib/control";
import { explainSetupError } from "@/lib/data/provider-setup";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import {
  isConfigured,
  isSetupProvider,
  parseProviderStatus,
  providerSetupValue,
  safeConnectMessage,
} from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

/**
 * Connects the selected organization's sandbox provider (`org/provider/connect`): an admin's Boat key or Modal token,
 * which the server checks with the provider and stores encrypted for the organization. One request, never retried;
 * the value is not kept, logged or shown again. Done only when the server's own status confirms the provider, then
 * the next step is the goldens page.
 */
export async function connectProvider(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const org = formString(data, "org");
  const provider = formString(data, "provider");
  if (!isUuid(org) || !isSetupProvider(provider)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const membership = (await listMemberships(await createClient(), viewer.id)).find((item) => item.org.id === org);
  if (membership?.role !== "admin") return fail("Only an admin of this organization connects its sandbox provider.");

  const fields = {
    boatKey: data.get("boat_key"),
    modalTokenId: data.get("modal_token_id"),
    modalTokenSecret: data.get("modal_token_secret"),
  };
  const checked = providerSetupValue(provider, fields);
  if (!checked.ok) return fail(checked.error);
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");

  let result: unknown;
  try {
    result = await createControlClient({ serverUrl, token: viewer.token }).post("org/provider/connect", {
      org,
      provider,
      value: checked.value,
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    const typed = [
      checked.value,
      ...Object.values(fields).map((value) => (typeof value === "string" ? value.trim() : "")),
    ];
    return fail(safeConnectMessage(explainSetupError(error), typed));
  }
  const status = parseProviderStatus(result, org);
  if (!status?.ready || !isConfigured(status, provider))
    return fail("The Armada server did not confirm the connection. Reload this page to check before trying again.");
  revalidatePath("/", "layout");
  redirect(`/goldens?connected=${provider}`);
}
