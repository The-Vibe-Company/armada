"use server";

import { EncryptionKeyError, encryptSecret, toBytea } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import {
  checkModalToken,
  checkSecretValue,
  credentialKindInfo,
  isCredentialKind,
  isCredentialScope,
  PERSONAL_KEY_STORAGE_UNAVAILABLE,
  personalKeyDbFailure,
} from "@/lib/credentials";
import { listCredentials } from "@/lib/data/credentials";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { CLOUD_PROVIDERS_LABEL } from "@/lib/labels";
import { CLOUD_PROVIDERS_PATH } from "@/lib/provider-setup";
import { createClient } from "@/lib/supabase/server";

/**
 * An organization's Boat and Modal credentials are its sandbox providers: connected, replaced and disconnected in
 * Machines → Cloud providers through the Armada server, which checks them with the provider first. They are not written here.
 */
const ORG_HOSTING_IN_PROVIDERS = `Organization cloud providers are managed in Machines → ${CLOUD_PROVIDERS_LABEL}.`;

/**
 * Stores one of the viewer's own hosting keys (Boat, Modal) as ciphertext. It is never read back: setting it again
 * replaces it. An organization's hosting is managed in Machines → Cloud providers (`ORG_HOSTING_IN_PROVIDERS`), and model
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
  if (scope === "org") return fail(ORG_HOSTING_IN_PROVIDERS);
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
    if (error instanceof EncryptionKeyError) return fail(PERSONAL_KEY_STORAGE_UNAVAILABLE);
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
  if (existing.error) return fail(personalKeyDbFailure(existing.error));

  if (existing.data) {
    const { data: rows, error } = await supabase
      .from("credentials")
      .update({ value_enc: valueEnc })
      .eq("id", existing.data.id)
      .select("id");
    if (error) return fail(personalKeyDbFailure(error));
    if (rows.length === 0) return fail("You are not allowed to do that.");
  } else {
    const { error } = await supabase.from("credentials").insert({ scope, owner_id: owner, kind, value_enc: valueEnc });
    if (error) return fail(personalKeyDbFailure(error));
  }
  revalidatePath(CLOUD_PROVIDERS_PATH);
  return done(`${credentialKindInfo(kind).label} saved.`);
}

export async function removeCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  if (formString(data, "scope") === "org" && formString(data, "kind") === "boat") return fail(ORG_HOSTING_IN_PROVIDERS);
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  const supabase = await createClient();
  const row = (await listCredentials(supabase)).find((item) => item.id === id);
  if (!row) return fail("That key is not available in this scope.");
  // A model credential is a named account, removed by id through the server (`creds/accounts/remove`).
  if (!isCredentialKind(row.kind)) return fail("Remove a subscription or API key on the Models page.");
  if (row.scope === "org") return fail(ORG_HOSTING_IN_PROVIDERS);
  const { data: rows, error } = await supabase.from("credentials").delete().eq("id", id).select("id");
  if (error) return fail(personalKeyDbFailure(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath(CLOUD_PROVIDERS_PATH);
  return done("Key removed.");
}
