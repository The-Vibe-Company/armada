"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError, controlPost } from "@/lib/control";
import { readDockerLaunchOption, readSelectedDockerHosts, viewerDockerHosts } from "@/lib/data/docker-hosts";
import { listSelectedAccounts } from "@/lib/data/model-accounts";
import { isSelectedOrganization, selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { HOSTS_PATH, hasCheckedIn } from "@/lib/docker-hosts";
import {
  checkImage,
  dockerLaunchBlocker,
  dockerLaunchBody,
  launchedDockerSandbox,
  UNKNOWN_DOCKER_LAUNCH,
} from "@/lib/docker-launch";
import { mcpUrl } from "@/lib/env";
import { LAUNCH_PATH, LAUNCH_TIMEOUT_MS } from "@/lib/launch";
import { LAUNCH_KEY_FIELD } from "@/lib/launch-key";
import { checkAccountChoice } from "@/lib/model-accounts";
import { modelChoice } from "@/lib/model-choice";

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
  try {
    const registration = await control.register(formString(data, "org"));
    revalidatePath(HOSTS_PATH);
    return { ok: true, ...registration };
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

/**
 * Launches Codex from a digest-pinned image on one of the organization's Docker hosts, as the signed-in viewer, then
 * answers the new sandbox's id for the dialog to follow. The form's request key is the server's `requestId`: a retry of the same form
 * (same choices) after an unanswered launch reuses it, so the server reconciles it instead of starting another.
 */
export async function launchOnDockerHost(
  _previous: ActionResult | null,
  data: FormData,
): Promise<ActionResult & { sandboxId?: string }> {
  const org = formString(data, "org");
  const hostId = formString(data, "hostId");
  const requestId = formString(data, LAUNCH_KEY_FIELD);
  if (!isUuid(org) || !isUuid(hostId) || !isUuid(requestId)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const image = checkImage(formString(data, "image"));
  if (!image.ok) return fail(image.error);
  const choice = modelChoice("codex", {
    model: formString(data, "model"),
    otherModel: formString(data, "other_model"),
    reasoningEffort: formString(data, "reasoning_effort"),
  });
  if (!choice.ok) return fail(choice.error);

  const [hosts, option, accounts] = await Promise.all([
    readSelectedDockerHosts(),
    readDockerLaunchOption(),
    listSelectedAccounts(),
  ]);
  if (hosts.state !== "ready") return fail("Docker hosts are not available right now.");
  const host = hosts.list.hosts.find((candidate) => candidate.id === hostId);
  if (!host) return fail("That host is not in this organization.");
  const blocker = dockerLaunchBlocker(option, hosts.list.placement, host);
  if (blocker) return fail(blocker);
  const account = checkAccountChoice(accounts, "codex", formString(data, "credential"), Date.now());
  if (!account.ok) return fail(account.error);
  if (!account.id) return fail("Choose which Codex account the agent runs on.");

  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  const prompt = formString(data, "prompt").trim();
  let id: string | null;
  try {
    id = launchedDockerSandbox(
      await controlPost(
        { serverUrl, token: viewer.token, timeoutMs: LAUNCH_TIMEOUT_MS },
        LAUNCH_PATH,
        dockerLaunchBody({
          org,
          hostId,
          image: image.image,
          credentialId: account.id,
          requestId,
          model: choice.args.model,
          reasoningEffort: choice.args.reasoningEffort,
          ...(prompt ? { prompt } : {}),
        }),
        "launching on Docker hosts",
      ),
    );
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.outcomeUnknown || error.code === "outcome_unknown") return fail(UNKNOWN_DOCKER_LAUNCH);
    return fail(error.message);
  }
  if (!id) return fail("The Armada server did not answer with a Docker sandbox.");
  revalidatePath("/sandboxes");
  // The dialog navigates once it has forgotten this launch's request key, so a later launch is a new request.
  return { ok: true, message: "Launched. Opening the sandbox…", sandboxId: id };
}
