"use server";

import { EncryptionKeyError, encryptSecret, toBytea } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import {
  checkModalToken,
  checkSecretValue,
  credentialKindInfo,
  isCredentialKind,
  isCredentialScope,
} from "@/lib/credentials";
import { listCredentials } from "@/lib/data/credentials";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { PROVIDER_SETTINGS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

/**
 * An organization's Boat and Modal credentials are its sandbox providers: connected, replaced and disconnected in
 * Settings through the Armada server, which checks them with the provider first. They are not written here.
 */
const ORG_HOSTING_IN_SETTINGS = "Organization sandbox providers are managed in Settings.";

/**
 * Stores one of the viewer's own hosting keys (Boat, Modal) as ciphertext. It is never read back: setting it again
 * replaces it. An organization's hosting is its providers in Settings (`ORG_HOSTING_IN_SETTINGS`), and model
 * credentials are named accounts on the server, so neither is written here.
 */
export async function saveCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const scope = formString(data, "scope");
  const kind = formString(data, "kind");
  if (!isCredentialScope(scope) || !isCredentialKind(kind)) return fail("That request is not valid.");

  const owner = scope === "user" ? viewer.id : formString(data, "owner");
  if (!isUuid(owner)) return fail("That request is not valid.");

  if (scope === "org" && !(await isSelectedOrganization(owner))) return fail("Switch to that organization first.");
  // Only hosting kinds are written here, and an organization's hosting is its providers in Settings.
  if (scope === "org") return fail(ORG_HOSTING_IN_SETTINGS);
  // A Modal token is a pair, checked and stored together; every other kind is one pasted value.
  const checked =
    kind === "modal"
      ? checkModalToken(data.get("modal_token_id"), data.get("modal_token_secret"))
      : checkSecretValue(data.get("value"));
  if (!checked.ok) return fail(checked.error);

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
  revalidatePath(PROVIDER_SETTINGS_PATH);
  return done(`${credentialKindInfo(kind).label} saved.`);
}

export async function removeCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  if (formString(data, "scope") === "org" && formString(data, "kind") === "boat") return fail(ORG_HOSTING_IN_SETTINGS);
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  const supabase = await createClient();
  const row = (await listCredentials(supabase)).find((item) => item.id === id);
  if (!row) return fail("That key is not available in this scope.");
  // A model credential is a named account, removed by id through the server (`creds/accounts/remove`).
  if (!isCredentialKind(row.kind)) return fail("Remove a subscription or API key on the Harness page.");
  if (row.scope === "org") return fail(ORG_HOSTING_IN_SETTINGS);
  const { data: rows, error } = await supabase.from("credentials").delete().eq("id", id).select("id");
  if (error) return fail(explainDbError(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath(PROVIDER_SETTINGS_PATH);
  return done("Key removed.");
}
