"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { GatewayError } from "@/lib/gateway";
import { launchArgs, type ModelFields, sendOverride } from "@/lib/model-choice";
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
    ...modelFields(data),
  });
  if (!parsed.ok) return fail(parsed.error);
  if (!isUuid(parsed.args.org)) return fail("That request is not valid.");
  if (!(await isSelectedOrganization(parsed.args.org))) return fail("Switch to that organization first.");
  const viewer = await requireViewer();
  const gateway = viewerGateway(viewer);
  if (!gateway) return fail("The Armada server is not configured for this dashboard.");
  let id: string;
  try {
    ({ id } = await gateway.launch(parsed.args));
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
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
