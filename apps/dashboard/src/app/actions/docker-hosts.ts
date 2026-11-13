"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { viewerDockerHosts } from "@/lib/data/docker-hosts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { HOSTS_PATH, hasCheckedIn, hostRegistrationCommand } from "@/lib/docker-hosts";

/**
 * The Hosts page's writes (#1380), one control API call each as the signed-in viewer from the dashboard's server.
 * The server checks the organization admin role; these checks only give a clearer refusal first.
 */
async function adminControl(org: string) {
  const selected = await selectedOrganization();
  if (!selected) return fail("Create an organization first.");
  if (org !== selected.org.id) return fail("Switch to that organization first.");
  if (selected.role !== "admin") return fail("Only an organization admin manages its Docker hosts.");
  const control = await viewerDockerHosts();
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  return control;
}

export type HostRegistrationResult =
  | { ok: true; hostId: string; registrationToken: string; command: string }
  | { ok: false; error: string };

/**
 * Issues a one-use registration ticket. The token goes back to the dialog that asked, once: it is not stored, logged
 * or put in a URL here, and the server keeps only its hash.
 */
export async function registerDockerHost(
  _previous: HostRegistrationResult | null,
  data: FormData,
): Promise<HostRegistrationResult> {
  const control = await adminControl(formString(data, "org"));
  if ("ok" in control) return control as { ok: false; error: string };
  const command = hostRegistrationCommand(control.serverUrl);
  if (!command) return { ok: false, error: "The Armada server address is not valid for a host to reach." };
  try {
    const registration = await control.register(formString(data, "org"));
    revalidatePath(HOSTS_PATH);
    return { ok: true, ...registration, command };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { ok: false, error: error.message };
  }
}

/** Whether the host the dialog registered has checked in; null when that cannot be read now. */
export async function dockerHostCheckedIn(org: string, hostId: string): Promise<boolean | null> {
  if (!isUuid(org) || !isUuid(hostId)) return null;
  const selected = await selectedOrganization();
  if (!selected || selected.org.id !== org) return null;
  const control = await viewerDockerHosts();
  if (!control) return null;
  try {
    const checkedIn = hasCheckedIn(await control.list(org), hostId);
    if (checkedIn) revalidatePath(HOSTS_PATH);
    return checkedIn;
  } catch (error) {
    if (error instanceof ControlError) return null;
    throw error;
  }
}

export async function revokeDockerHost(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const hostId = formString(data, "hostId");
  if (!isUuid(hostId)) return fail("That request is not valid.");
  const control = await adminControl(formString(data, "org"));
  if ("ok" in control) return control;
  try {
    await control.revoke(formString(data, "org"), hostId);
    revalidatePath(HOSTS_PATH);
    return done("The host is revoked: it takes no new work.");
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(error.message);
  }
}
