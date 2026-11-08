"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { viewerGateway } from "@/lib/data/gateway";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { GatewayError } from "@/lib/gateway";
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
  try {
    await target.gateway.send(id, prompt);
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.message);
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Sent. The reply appears in the logs.");
}
