"use server";

// Setting and deleting keys in the vault (THE-840), as server actions. Each
// form posts here and the action answers with a redirect to the Keys page,
// with its outcome in the query. A value only travels from the form to
// `setSecret`: it is never echoed back, logged or put in a redirect. Owners
// and admins set the organization's keys and each project's (THE-859: its
// Linear key, its secrets for workers); every member sets their own Linear
// key, which only their terminals receive.
import { redirect } from "next/navigation";
import { requireAccounts, requireMember } from "@/lib/accounts-server";
import { KEYS_PATH } from "@/lib/accounts-settings";
import { projectsOf } from "@/lib/fleet-store";
import type { KeysError, KeysNotice } from "@/lib/i18n";
import {
  checkWorkerSecret,
  deleteSecret,
  isSecretName,
  isWorkerSecretName,
  SECRET_KINDS,
  setSecret,
  targetRefusal,
  vaultModeOf,
} from "@/lib/vault";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

const page = (result: { done: KeysNotice } | { error: KeysError }, project = "") => {
  const query = new URLSearchParams(project ? { project } : {});
  if ("done" in result) query.set("done", result.done);
  else query.set("error", result.error);
  return `${KEYS_PATH}?${query}`;
};

/**
 * The key or secret a form names, and whose it is: the organization's or a
 * project's (owners and admins), or the viewer's own Linear key.
 */
async function target(form: FormData) {
  const viewer = await requireMember();
  const scope = text(form, "scope");
  const project = scope === "project" ? text(form, "project") : "";
  const back = (error: KeysError) => redirect(page({ error }, project));
  // A typed name as it is; a worker secret's in upper case, as the CLI takes it.
  const raw = text(form, "name");
  const name = isSecretName(raw) ? raw : raw.toUpperCase();
  const own = scope === "own";
  if (!isSecretName(name) && !isWorkerSecretName(name)) back("name");
  if (targetRefusal({ organization: viewer.organization.id, project, user: own ? viewer.user.id : null, name }))
    back("invalid");
  const manager = viewer.organization.role === "owner" || viewer.organization.role === "admin";
  if (!own && !manager) back("forbidden");
  const { client } = await requireAccounts();
  if (project && !(await projectsOf(client, viewer.organization.id)).some((p) => p.slug === project)) back("project");
  return {
    client,
    name,
    organization: viewer.organization.id,
    project: project || null,
    user: own ? viewer.user.id : null,
    actor: { kind: "person" as const, id: viewer.user.id, label: viewer.signature },
  };
}

export async function saveKey(form: FormData): Promise<void> {
  const vault = vaultModeOf(process.env);
  if (vault.kind !== "on") redirect(page({ error: "vault" }, text(form, "project")));
  const { client, ...t } = await target(form);
  const value = isSecretName(t.name) ? text(form, "value") : String(form.get("value") ?? "");
  const valid = isSecretName(t.name) ? SECRET_KINDS[t.name].check(value) : checkWorkerSecret(value);
  if (!value || !valid) redirect(page({ error: "invalid" }, t.project ?? ""));
  let result: Parameters<typeof page>[0];
  try {
    await setSecret(client, vault.key, { ...t, value, now: new Date() });
    result = { done: "saved" };
  } catch (err) {
    // The error is the database's, never the value's.
    console.error(`armada dashboard: ${t.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
    result = { error: "failed" };
  }
  redirect(page(result, t.project ?? ""));
}

export async function deleteKey(form: FormData): Promise<void> {
  const { client, ...t } = await target(form);
  let result: Parameters<typeof page>[0];
  try {
    await deleteSecret(client, { ...t, now: new Date() });
    result = { done: "deleted" };
  } catch (err) {
    console.error(`armada dashboard: ${t.name} not deleted: ${err instanceof Error ? err.message : String(err)}`);
    result = { error: "failed" };
  }
  redirect(page(result, t.project ?? ""));
}
