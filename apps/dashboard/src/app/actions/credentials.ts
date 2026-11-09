"use server";

import { EncryptionKeyError, encryptSecret, toBytea } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { ControlError, createControlClient } from "@/lib/control";
import {
  checkModalToken,
  checkSecretValue,
  credentialKindInfo,
  isCredentialKind,
  isCredentialScope,
} from "@/lib/credentials";
import { listCredentials } from "@/lib/data/credentials";
import { explainSetupError } from "@/lib/data/provider-setup";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer, type Viewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { isConfigured, parseProviderStatus, safeConnectMessage } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

/**
 * Stores a key, token or secret as ciphertext, in the viewer's own scope or (admins) the selected org's. It is
 * never read back: setting it again replaces it. The org Boat key is the Armada server's: see `orgBoatControl`.
 */
export async function saveCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const scope = formString(data, "scope");
  const kind = formString(data, "kind");
  if (!isCredentialScope(scope) || !isCredentialKind(kind)) return fail("That request is not valid.");

  const owner = scope === "user" ? viewer.id : formString(data, "owner");
  if (!isUuid(owner)) return fail("That request is not valid.");

  if (scope === "org" && !(await isSelectedOrganization(owner))) return fail("Switch to that organization first.");
  // A Modal token is a pair, checked and stored together; every other kind is one pasted value.
  const checked =
    kind === "modal"
      ? checkModalToken(data.get("modal_token_id"), data.get("modal_token_secret"))
      : checkSecretValue(data.get("value"));
  if (!checked.ok) return fail(checked.error);
  if (scope === "org" && kind === "boat") return saveOrgBoatKey(viewer, owner, checked.value, data.get("value"));

  let sealed: Uint8Array;
  try {
    sealed = await encryptSecret(checked.value);
  } catch (error) {
    if (error instanceof EncryptionKeyError) return fail(error.message);
    throw error;
  }
  const valueEnc = toBytea(sealed);

  const supabase = await createClient();
  const existing = await supabase
    .from("credentials")
    .select("id")
    .eq("scope", scope)
    .eq("owner_id", owner)
    .eq("kind", kind)
    .maybeSingle();
  if (existing.error) return fail(explainDbError(existing.error));

  if (existing.data) {
    const { data: rows, error } = await supabase
      .from("credentials")
      .update({ value_enc: valueEnc })
      .eq("id", existing.data.id)
      .select("id");
    if (error) return fail(explainDbError(error));
    if (rows.length === 0) return fail("You are not allowed to do that.");
  } else {
    const { error } = await supabase.from("credentials").insert({ scope, owner_id: owner, kind, value_enc: valueEnc });
    if (error) return fail(explainDbError(error));
  }
  revalidatePath("/credentials");
  return done(`${credentialKindInfo(kind).label} saved.`);
}

export async function removeCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  if (formString(data, "scope") === "org" && formString(data, "kind") === "boat") {
    const org = formString(data, "owner");
    if (!isUuid(org)) return fail("That request is not valid.");
    if (!(await isSelectedOrganization(org))) return fail("Switch to that organization first.");
    return removeOrgBoatKey(viewer, org);
  }
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  const supabase = await createClient();
  if (!(await listCredentials(supabase)).some((row) => row.id === id))
    return fail("That credential is not available in this scope.");
  const { data: rows, error } = await supabase.from("credentials").delete().eq("id", id).select("id");
  if (error) return fail(explainDbError(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath("/credentials");
  return done("Credential removed.");
}

/**
 * The org Boat key is `orgs.boat_api_key_enc`, the one key launches and golden builds resolve; a user JWT can
 * neither read it nor tell whether it is set. So it is saved, shown and removed through the Armada server's own
 * policy (`org/provider/connect`, `org/provider/status`, `creds/rm`), which checks the admin role itself.
 */
function orgBoatControl(viewer: Viewer) {
  const serverUrl = mcpUrl();
  return serverUrl && viewer.token ? createControlClient({ serverUrl, token: viewer.token }) : null;
}

async function saveOrgBoatKey(viewer: Viewer, org: string, value: string, raw: unknown): Promise<ActionResult> {
  const control = orgBoatControl(viewer);
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  let result: unknown;
  try {
    result = await control.post("org/provider/connect", { org, provider: "boat", value });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(safeConnectMessage(explainSetupError(error), [value, typeof raw === "string" ? raw.trim() : ""]));
  }
  const status = parseProviderStatus(result, org);
  if (!status || !isConfigured(status, "boat"))
    return fail("The Armada server did not confirm the key. Reload this page to check before trying again.");
  revalidatePath("/", "layout");
  return done(`${credentialKindInfo("boat").label} saved.`);
}

async function removeOrgBoatKey(viewer: Viewer, org: string): Promise<ActionResult> {
  const control = orgBoatControl(viewer);
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  try {
    await control.post("creds/rm", { scope: "org", org, kind: "boat" });
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(explainSetupError(error));
  }
  revalidatePath("/", "layout");
  return done("Credential removed.");
}
