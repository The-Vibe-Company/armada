"use server";

import type { Golden, SandboxProviderId } from "@armada/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient, isGoldenBuildStatus, isGoldenRemoval } from "@/lib/control";
import { listGoldens } from "@/lib/data/goldens";
import { newWorkBlocker } from "@/lib/data/provider-setup";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { goldenRemoveBlocker, goldenRequest, goldenRowState, PROVIDER_LABELS, type RepoRow } from "@/lib/golden-form";
import { createClient } from "@/lib/supabase/server";

export async function setGoldenVisibility(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const golden = formString(data, "golden");
  const visibility = formString(data, "visibility");
  if (!isUuid(golden) || (visibility !== "org" && visibility !== "private")) return fail("That request is not valid.");
  const supabase = await createClient();
  if (!(await listGoldens(supabase)).some((row) => row.id === golden))
    return fail("That golden is not available in this scope.");
  const { error } = await supabase.rpc("set_golden_visibility", { target_golden: golden, new_visibility: visibility });
  if (error) return fail(explainDbError(error));
  revalidatePath("/goldens");
  return done(visibility === "org" ? "Shared with the org." : "Now private to you.");
}

/**
 * Creates or rebuilds a golden through the server's secure builder (`golden/create`, `golden/update`): the server
 * clones over the caller's GitHub connection, scans for leaked tokens and snapshots on the golden's provider.
 * Create sends the provider chosen in the form (Boat or Modal). A rebuild targets the stored row by its id: its
 * name and provider come from that row, never from the form, so a same-name golden of the other provider is never
 * rebuilt instead. This action forwards the checked form with the session token and its idempotency key, once;
 * it never retries. The server answers 202 with a durable job, which the form then polls.
 */
export async function buildGolden(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const mode = formString(data, "mode");
  const org = formString(data, "org");
  if (!isUuid(org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const blocker = await newWorkBlocker(org);
  if (blocker) return fail(blocker);
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");

  let target: Golden | undefined;
  if (mode === "update") {
    const goldenId = formString(data, "golden");
    if (!isUuid(goldenId)) return fail("That request is not valid.");
    const supabase = await createClient();
    const [goldens, memberships] = await Promise.all([listGoldens(supabase), listMemberships(supabase, viewer.id)]);
    target = goldens.find((row) => row.id === goldenId && row.org_id === org);
    if (!target) return fail("That golden is not available in this scope.");
    const isAdmin = memberships.some((item) => item.org.id === target?.org_id && item.role === "admin");
    const state = goldenRowState(target, goldens, { id: viewer.id, isAdmin });
    if (!state.canRebuild) return fail(state.reason ?? "This golden cannot be rebuilt here.");
  }
  const parsed = goldenRequest({
    mode,
    name: target ? target.name : formString(data, "name"),
    org,
    provider: target ? target.provider : formString(data, "provider"),
    visibility: formString(data, "visibility"),
    repos: repoRows(data),
    init: formString(data, "init"),
    setup: formString(data, "setup"),
  });
  if (!parsed.ok) return fail(parsed.error);
  const request = parsed.value;

  // Saved in the page's URL before this request, so a lost answer can be recovered instead of resubmitted.
  const idempotencyKey = formString(data, "idempotencyKey");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return fail("Reload the page: this build request has no valid key.");

  const client = createControlClient({ serverUrl, token: viewer.token });
  let result: unknown;
  try {
    result = await client.post(request.mode === "create" ? "golden/create" : "golden/update", {
      ...request.body,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ControlError) return fail(explainBuildError(error, request.body.provider));
    throw error;
  }
  if (!isGoldenBuildStatus(result)) return fail("The Armada server sent an unexpected answer.");
  if (result.state === "succeeded") {
    revalidatePath("/goldens");
    revalidatePath("/sandboxes");
  }
  // An admitted job, not a finished build: the form polls its status. No snapshot is assumed here.
  return {
    ok: true,
    message: `${PROVIDER_LABELS[request.body.provider]} build admitted: ${result.jobId}.`,
    build: result,
  };
}

/** One authenticated, bounded status read by job id; never submits or retries a build. */
export async function goldenBuildStatus(jobId: string) {
  const viewer = await requireViewer();
  if (!isUuid(jobId)) throw new Error("Invalid build id.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) throw new Error("The Armada server is not configured.");
  const result = await createControlClient({ serverUrl, token: viewer.token }).post("golden/build/status", { jobId });
  if (!isGoldenBuildStatus(result)) throw new Error("Unexpected build status.");
  if (result.state === "succeeded") {
    revalidatePath("/goldens");
    revalidatePath("/sandboxes");
  }
  return result;
}

/**
 * Recovers a lost admission receipt by the key saved before submitting, in the selected org only. It reads; it
 * never submits another build.
 */
export async function recoverGoldenBuild(idempotencyKey: string, org: string) {
  const viewer = await requireViewer();
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error("Invalid build key.");
  if (!isUuid(org) || !(await isSelectedOrganization(org))) throw new Error("Select the build's organization.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) throw new Error("The Armada server is not configured.");
  const result = await createControlClient({ serverUrl, token: viewer.token }).post("golden/build/status", {
    org,
    idempotencyKey,
  });
  if (!isGoldenBuildStatus(result)) throw new Error("Unexpected build status.");
  return result;
}

/**
 * Retires a golden through the Armada server (`golden/remove {id, org}`, #566) with the viewer's session. The server
 * keeps the row as a tombstone: sandboxes started from it, their conversations and logs stay, and provider artifacts
 * are retained. This action only narrows the request to a golden visible in the selected org and the owner/admin
 * rule; the server checks both again. One request, never retried. On success the lists are refreshed and the page
 * says what was removed.
 */
export async function removeGolden(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const goldenId = formString(data, "golden");
  const org = formString(data, "org");
  if (!isUuid(goldenId) || !isUuid(org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  const supabase = await createClient();
  const [goldens, memberships] = await Promise.all([listGoldens(supabase), listMemberships(supabase, viewer.id)]);
  const target = goldens.find((row) => row.id === goldenId && row.org_id === org);
  if (!target) return fail("That golden is not available in this scope.");
  const isAdmin = memberships.some((item) => item.org.id === org && item.role === "admin");
  const blocker = goldenRemoveBlocker(target, { id: viewer.id, isAdmin });
  if (blocker) return fail(blocker);
  let result: unknown;
  try {
    result = await createControlClient({ serverUrl, token: viewer.token }).post("golden/remove", {
      id: target.id,
      org,
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.status === 404 && error.code === undefined)
      return fail("This Armada server does not offer removing goldens yet.");
    return fail(error.message);
  }
  if (!isGoldenRemoval(result) || result.id !== target.id) return fail("The Armada server sent an unexpected answer.");
  revalidatePath("/goldens");
  revalidatePath("/sandboxes");
  redirect(`/goldens?removed=${target.id}`);
}

/** The server's idempotency key shape: 16–128 letters, digits, underscores or hyphens. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function repoRows(data: FormData): RepoRow[] {
  const urls = data.getAll("repo_url");
  const branches = data.getAll("repo_branch");
  const dirs = data.getAll("repo_dir");
  return urls.map((url, index) => ({
    url: typeof url === "string" ? url : "",
    branch: typeof branches[index] === "string" ? (branches[index] as string) : "",
    dir: typeof dirs[index] === "string" ? (dirs[index] as string) : "",
  }));
}

function explainBuildError(error: ControlError, provider: SandboxProviderId): string {
  if (provider === "boat" && error.code === "conflict" && /golden capacity/i.test(error.message))
    return `${error.message} A Boat account holds one golden: rebuild the existing golden instead of creating another.`;
  if (error.status === 404 && error.code === undefined)
    return "This Armada server does not offer secure golden builds yet.";
  // A gateway in front of the server gave up, not the server: the build may still be running.
  if ((error.status === 502 || error.status === 504) && error.code === undefined)
    return "The Armada server did not answer in time. The build may still finish: refresh before trying again.";
  return error.message;
}
