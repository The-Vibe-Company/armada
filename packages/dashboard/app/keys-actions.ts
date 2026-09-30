"use server";

// Setting and deleting keys in the vault (THE-840), as server actions. Each
// form posts here and the action answers with a redirect to the Keys page,
// with its outcome in the query. A value only travels from the form to
// `setSecret`: it is never echoed back, logged or put in a redirect. Owners
// and admins set the organization's keys; every member sets their own Linear
// key, which only their terminals receive.
import { redirect } from "next/navigation";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { KEYS_PATH } from "@/lib/accounts-settings";
import type { KeysError, KeysNotice } from "@/lib/i18n";
import { deleteSecret, isSecretName, SECRET_KINDS, type SecretName, setSecret, vaultModeOf } from "@/lib/vault";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

const page = (result: { done: KeysNotice } | { error: KeysError }) =>
  "done" in result ? `${KEYS_PATH}?done=${result.done}` : `${KEYS_PATH}?error=${result.error}`;

/** The key a form names, and whose it is: the organization's (owners and admins) or the viewer's own. */
async function target(form: FormData) {
  const viewer = await requireMember();
  const name = text(form, "name");
  const own = text(form, "scope") === "own";
  if (!isSecretName(name) || (own && !SECRET_KINDS[name].personal)) redirect(page({ error: "invalid" }));
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  if (!own && !manager) redirect(page({ error: "forbidden" }));
  return {
    name: name as SecretName,
    organization: viewer.organization.id,
    user: own ? viewer.user.id : null,
    actor: { kind: "person" as const, id: viewer.user.id, label: viewer.signature },
  };
}

export async function saveKey(form: FormData): Promise<void> {
  const vault = vaultModeOf(process.env);
  if (vault.kind !== "on") redirect(page({ error: "vault" }));
  const t = await target(form);
  const value = text(form, "value");
  if (!value || !SECRET_KINDS[t.name].check(value)) redirect(page({ error: "invalid" }));
  const { client } = await requireAccounts();
  let result: Parameters<typeof page>[0];
  try {
    await setSecret(client, vault.key, { ...t, value, now: new Date() });
    result = { done: "saved" };
  } catch (err) {
    // The error is the database's, never the value's.
    console.error(`armada dashboard: ${t.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
    result = { error: "failed" };
  }
  redirect(page(result));
}

export async function deleteKey(form: FormData): Promise<void> {
  const t = await target(form);
  const { client } = await requireAccounts();
  let result: Parameters<typeof page>[0];
  try {
    await deleteSecret(client, { ...t, now: new Date() });
    result = { done: "deleted" };
  } catch (err) {
    console.error(`armada dashboard: ${t.name} not deleted: ${err instanceof Error ? err.message : String(err)}`);
    result = { error: "failed" };
  }
  redirect(page(result));
}
