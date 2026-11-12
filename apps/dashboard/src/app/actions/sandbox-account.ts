"use server";

import { revalidatePath } from "next/cache";
import { bindableStatus, bindFailure, needsAccountChoice } from "@/lib/account-recovery";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient } from "@/lib/control";
import { getSandbox } from "@/lib/data/sandboxes";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Binds the chosen account to a legacy Modal sandbox (`sandbox/bind-credential`). Only an explicit, confirmed choice
 * is sent; the server checks ownership, membership, the account and a safely stopped machine, and binds atomically.
 * Nothing is relaunched: the next message resumes the same workspace and conversation.
 */
export async function bindSandboxAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox");
  const credentialId = formString(data, "credential");
  if (!isUuid(id)) return fail("That request is not valid.");
  if (!isUuid(credentialId)) return fail("Choose an account first.");
  if (formString(data, "confirm") !== "yes") return fail("Confirm the account first.");
  const viewer = await requireViewer();
  const sandbox = await getSandbox(await createClient(), id);
  if (!sandbox) return fail("That sandbox does not exist, or it is not yours to see.");
  if (sandbox.owner_id !== viewer.id) return fail(bindFailure("forbidden", ""));
  if (!needsAccountChoice(sandbox)) return fail(bindFailure("conflict", ""));
  if (bindableStatus(sandbox.status) !== "ready") return fail(bindFailure("credential_binding_unsafe", ""));
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  try {
    await createControlClient({ serverUrl, token: viewer.token }).post("sandbox/bind-credential", {
      id,
      credentialId,
      org: sandbox.org_id,
    });
  } catch (error) {
    if (error instanceof ControlError) return fail(bindFailure(error.code, error.message));
    throw error;
  }
  revalidatePath(`/sandboxes/${id}`);
  return done("Account bound. Send a message to resume the sandbox.");
}

/** Explicit same-harness account change; the server owns quiescence and native delivery. */
export async function repointSandboxAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const id = formString(data, "sandbox"),
    credentialId = formString(data, "credential");
  if (!isUuid(id) || !isUuid(credentialId)) return fail("Choose a sandbox and an account first.");
  if (formString(data, "confirm") !== "yes") return fail("Confirm the account first.");
  const viewer = await requireViewer();
  const sandbox = await getSandbox(await createClient(), id);
  if (!sandbox || sandbox.owner_id !== viewer.id) return fail("Only the sandbox owner can change its account.");
  if (sandbox.status === "deleted") return fail("A deleted sandbox cannot change accounts.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) return fail("The Armada server is not configured for this dashboard.");
  try {
    await createControlClient({ serverUrl, token: viewer.token }).post("sandbox/repoint-credential", {
      id,
      credentialId,
      org: sandbox.org_id,
    });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.code === "forbidden" || error.code === "not_found")
      return fail("Only the current sandbox owner, still a member of its organization, can change its account.");
    if (error.code === "conflict" || error.code === "credential_binding_unsafe")
      return fail("Finish or stop active work and wait for sandbox operations to settle, then try again.");
    if (error.code === "credential_refused" || error.code === "no_credentials")
      return fail("Choose an active account for this sandbox's harness.");
    return fail("The account change could not be confirmed. Refresh the sandbox before retrying.");
  }
  revalidatePath(`/sandboxes/${id}`);
  revalidatePath("/sandboxes");
  return done("Account changed. The workspace and conversations are retained.");
}
