"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { chosenConversation, INCOMPLETE_MODEL, modelChange, STEER_KEEPS_MODEL } from "@/lib/composer";
import { launchSelection, type McpConnection } from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { listSelectedConnections } from "@/lib/data/connections";
import { viewerGateway } from "@/lib/data/gateway";
import { listGoldens } from "@/lib/data/goldens";
import { newWorkBlocker } from "@/lib/data/provider-setup";
import { getSandbox } from "@/lib/data/sandboxes";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { GatewayError } from "@/lib/gateway";
import { launchSandbox } from "@/lib/launch";
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
  return { gateway, sandbox, owner: sandbox.owner_id === viewer.id };
}

/**
 * A refused send, steer or interrupt in words. An unbound legacy Modal sandbox (`credential_binding_required`) is
 * recovered on this page, not with the CLI command the server's own message names.
 */
function drivingFailure(error: GatewayError, owner: boolean): ActionResult {
  if (error.code !== "credential_binding_required") return fail(error.message);
  return fail(
    owner
      ? "This sandbox needs an account before it can resume. Choose one above."
      : "This sandbox needs an account before it can resume. Only its owner can choose it.",
  );
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

/** A new turn, in the conversation the person chose. The model and effort override applies to this turn only. */
export async function sendToSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const prompt = formString(data, "prompt").trim();
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!prompt) return fail("Write the message to send.");
  if (modelChange(modelFields(data)) === "incomplete") return fail(INCOMPLETE_MODEL);
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  const override = sendOverride(target.sandbox.harness, modelFields(data), target.sandbox.model);
  if (!override.ok) return fail(override.error);
  try {
    await target.gateway.send(id, prompt, override.args, conversation.id);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Sent.");
}

/** A message into the turn running in the chosen conversation. It never changes the model: that is a new turn. */
export async function steerSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const text = formString(data, "prompt").trim();
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!text) return fail("Write the message to send.");
  if (modelChange(modelFields(data)) !== "none") return fail(STEER_KEEPS_MODEL);
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  let receipt: unknown;
  try {
    receipt = await target.gateway.steer(id, text, conversation.id);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  const restarted =
    typeof receipt === "object" && receipt !== null && "delivery" in receipt && receipt.delivery === "restart";
  return done(restarted ? "Steered. The turn restarted with your message." : "Steered.");
}

/** Stops the turn running in the chosen conversation. The sandbox stays up for the next message. */
export async function interruptSandbox(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  if (!isUuid(id)) return fail("That request is not valid.");
  const target = await gatewayFor(id);
  if (target.error) return target.error;
  const conversation = chosenConversation(formString(data, "conversation"), target.sandbox.conversation_ids);
  if (!conversation.ok) return fail(conversation.error);
  try {
    await target.gateway.interrupt(id, conversation.id);
  } catch (error) {
    if (error instanceof GatewayError) return drivingFailure(error, target.owner);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Interrupt requested.");
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
  const blocker = await newWorkBlocker(parsed.args.org, parsed.args.provider);
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

  let id: string;
  try {
    ({ id } = await launchSandbox(
      { serverUrl, token: viewer.token },
      { ...parsed.args, ...selection.value, ...(repository.repo === undefined ? {} : { repo: repository.repo }) },
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
