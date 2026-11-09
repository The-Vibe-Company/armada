"use server";

import type { Harness } from "@armada/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { launchSelection, type McpConnection } from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { viewerGateway } from "@/lib/data/gateway";
import { listGoldens } from "@/lib/data/goldens";
import { listSelectedAccounts } from "@/lib/data/model-accounts";
import { newWorkBlocker } from "@/lib/data/provider-setup";
import { getSandbox } from "@/lib/data/sandboxes";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { GatewayError } from "@/lib/gateway";
import { launchSandbox } from "@/lib/launch";
import { accountProblem, accountsFor } from "@/lib/model-accounts";
import { launchArgs, type ModelFields, sendOverride } from "@/lib/model-choice";
import { goldenRepositoryDirs, repositoryChoice } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";

async function gatewayFor(id: string) {
  const viewer = await requireViewer();
  const gateway = viewerGateway(viewer);
  if (!gateway) return { error: fail("The Armada server is not configured for this dashboard.") };
  const supabase = await createClient();
  const sandbox = await getSandbox(supabase, id);
  if (!sandbox) return { error: fail("That sandbox does not exist, or it is not yours to see.") };
  return { gateway, sandbox };
}

export async function stopSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  try {
    await target.gateway.stop(id);
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Stop requested. The machine is removed and the disk is kept.");
}

export async function sendToSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const prompt = formString(data, "prompt").trim();
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!prompt) return fail("Write the message to send.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const override = sendOverride(target.sandbox.harness, modelFields(data), target.sandbox.model);
  if (!override.ok) return fail(override.error);
  try {
    await target.gateway.send(id, prompt, override.args);
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Sent. The reply appears in the logs.");
}

export async function launchFromGolden(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const parsed = launchArgs({
    golden: formString(data, "golden"),
    provider: formString(data, "provider"),
    org: formString(data, "org"),
    harness: formString(data, "harness"),
    prompt: formString(data, "prompt"),
    repo: formString(data, "repo"),
    ...modelFields(data),
  });
  if (!parsed.ok) return fail(parsed.error);
  if (!isUuid(parsed.args.org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(parsed.args.org))) return fail("Switch to that organization first.");
  const blocker = await newWorkBlocker(parsed.args.org);
  if (blocker) return fail(blocker);
  const viewer = await requireViewer();
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");

  const matches = (await listGoldens(await createClient())).filter(
    (golden) =>
      golden.name === parsed.args.golden &&
      golden.provider === parsed.args.provider &&
      golden.org_id === parsed.args.org,
  );
  if (matches.length === 0) return fail("That golden is not available in this organization.");
  const requested = data.getAll("connections").map(String);
  let available: McpConnection[] = [];
  if (requested.length > 0) {
    const listed = await listSelectedConnections();
    if (listed.state !== "ready") {
      return fail(listed.state === "error" ? listed.message : "Connections are not available right now.");
    }
    available = listed.connections;
  }
  const selection = launchSelection({
    visibility: formString(data, "visibility"),
    connections: requested,
    goldenVisibility: matches.some((golden) => golden.visibility === "org") ? "org" : "private",
    available,
  });
  if (!selection.ok) return fail(selection.error);
  const repository = repositoryChoice(
    formString(data, "repo"),
    matches.flatMap((golden) => goldenRepositoryDirs(golden.config)),
  );
  if (!repository.ok) return fail(repository.error);
  const account = await accountChoice(parsed.args.harness, formString(data, "credential"));
  if (!account.ok) return fail(account.error);

  let id: string;
  try {
    ({ id } = await launchSandbox(
      { serverUrl, token: viewer.token },
      {
        ...parsed.args,
        ...selection.value,
        ...(repository.repo === undefined ? {} : { repo: repository.repo }),
        ...(account.id === undefined ? {} : { credentialId: account.id }),
      },
    ));
  } catch (error) {
    if (error instanceof ControlError) return fail(error.message);
    throw error;
  }
  revalidatePath("/sandboxes");
  redirect(`/sandboxes/${id}`);
}

function modelFields(data: FormData): ModelFields {
  return {
    model: formString(data, "model"),
    otherModel: formString(data, "other_model"),
    reasoningEffort: formString(data, "reasoning_effort"),
  };
}

/**
 * The model account a launch bills, checked against what the viewer may use now. With compatible accounts listed
 * the person must have chosen one; it is sent as an explicit id, never left for the server to pick. A server older
 * than named accounts gets none and resolves its own. Accounts that cannot be read block the launch.
 */
async function accountChoice(
  harness: Harness,
  requested: string,
): Promise<{ ok: true; id: string | undefined } | { ok: false; error: string }> {
  if (requested && !isUuid(requested)) return { ok: false, error: "That request is not valid." };
  const list = await listSelectedAccounts();
  if (list.state === "legacy") return { ok: true, id: undefined };
  if (list.state !== "ready")
    return {
      ok: false,
      error: `Model accounts could not be loaded${list.state === "error" ? `: ${list.message}` : "."} Reload and try again.`,
    };
  const compatible = accountsFor(list.accounts, harness);
  if (compatible.length === 0) {
    return requested
      ? { ok: false, error: "That account is not available for this agent." }
      : { ok: true, id: undefined };
  }
  if (!requested) return { ok: false, error: "Choose which account the agent runs on." };
  const chosen = compatible.find((item) => item.id === requested);
  if (!chosen) return { ok: false, error: "That account is not available for this agent. Reload and choose again." };
  const problem = accountProblem(chosen, Date.now());
  if (problem) return { ok: false, error: `${chosen.name} is ${problem}. Replace its token or choose another.` };
  return { ok: true, id: chosen.id };
}
