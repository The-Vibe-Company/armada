"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient, isGoldenBuildResult } from "@/lib/control";
import { listGoldens } from "@/lib/data/goldens";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { listMemberships, requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { goldenRequest, goldenRowState, type RepoRow } from "@/lib/golden-form";
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
 * Creates or rebuilds a Boat golden through the server's secure builder (`golden/create`, `golden/update`):
 * the server clones over the caller's GitHub connection, scans for leaked tokens and snapshots. This action
 * only forwards the checked form with the session token, once; it never retries a failed build.
 */
export async function buildGolden(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const parsed = goldenRequest({
    mode: formString(data, "mode"),
    name: formString(data, "name"),
    org: formString(data, "org"),
    visibility: formString(data, "visibility"),
    repos: repoRows(data),
    init: formString(data, "init"),
    setup: formString(data, "setup"),
  });
  if (!parsed.ok) return fail(parsed.error);
  const request = parsed.value;
  if (!isUuid(request.body.org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(request.body.org))) return fail("Switch to that organization first.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");

  if (request.mode === "update") {
    const supabase = await createClient();
    const [goldens, memberships] = await Promise.all([listGoldens(supabase), listMemberships(supabase, viewer.id)]);
    const target = goldens.find((row) => row.name === request.body.name && row.provider === "boat");
    if (!target) return fail("That golden is not available in this scope.");
    const isAdmin = memberships.some((item) => item.org.id === target.org_id && item.role === "admin");
    const state = goldenRowState(target, goldens, { id: viewer.id, isAdmin });
    if (!state.canRebuild) return fail(state.reason ?? "This golden cannot be rebuilt here.");
  }

  const client = createControlClient({ serverUrl, token: viewer.token });
  let result: unknown;
  try {
    result = await client.post(request.mode === "create" ? "golden/create" : "golden/update", request.body);
  } catch (error) {
    if (error instanceof ControlError) return fail(explainBuildError(error));
    throw error;
  }
  if (!isGoldenBuildResult(result)) return fail("The Armada server sent an unexpected answer.");
  revalidatePath("/goldens");
  revalidatePath("/sandboxes");
  return done(
    `${request.mode === "create" ? "Built" : "Rebuilt"} golden '${result.name}' and saved snapshot ${result.snapshot}.`,
  );
}

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

function explainBuildError(error: ControlError): string {
  if (error.code === "conflict" && /golden capacity/i.test(error.message))
    return `${error.message} A Boat account holds one golden: rebuild the existing golden instead of creating another.`;
  if (error.status === 404 && error.code === undefined)
    return "This Armada server does not offer secure golden builds yet.";
  return error.message;
}
