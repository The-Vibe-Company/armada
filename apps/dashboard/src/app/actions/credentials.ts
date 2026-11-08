"use server";

import { EncryptionKeyError, encryptSecret, toBytea } from "@armada/core";
import { revalidatePath } from "next/cache";
import { type ActionResult, done, explainDbError, fail, formString, isUuid } from "@/lib/action";
import { checkSecretValue, credentialKindInfo, isCredentialKind, isCredentialScope } from "@/lib/credentials";
import { requireViewer } from "@/lib/data/viewer";
import { createClient } from "@/lib/supabase/server";

/** Stores a key, token or secret as ciphertext. It is never read back: setting it again replaces it. */
export async function saveCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const scope = formString(data, "scope");
  const kind = formString(data, "kind");
  if (!isCredentialScope(scope) || !isCredentialKind(kind)) return fail("That request is not valid.");

  const owner = scope === "user" ? viewer.id : formString(data, "owner");
  if (!isUuid(owner)) return fail("That request is not valid.");

  const checked = checkSecretValue(data.get("value"));
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
  revalidatePath("/credentials");
  return done(`${credentialKindInfo(kind).label} saved.`);
}

export async function removeCredential(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  await requireViewer();
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  const supabase = await createClient();
  const { data: rows, error } = await supabase.from("credentials").delete().eq("id", id).select("id");
  if (error) return fail(explainDbError(error));
  if (rows.length === 0) return fail("You are not allowed to do that.");
  revalidatePath("/credentials");
  return done("Credential removed.");
}
