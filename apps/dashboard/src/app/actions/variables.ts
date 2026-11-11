"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerVault } from "@/lib/data/variables";
import { nameProblem, type VaultKind, valueProblem, vaultFailure } from "@/lib/variables";

/**
 * The Variables page's writes (#935), each one control API call as the signed-in viewer. A submitted value goes to
 * the server once and is never returned, logged or put in a message: every answer names the item, never its value.
 */
type Vault = NonNullable<Awaited<ReturnType<typeof viewerVault>>>;

async function scoped(data: FormData): Promise<{ vault: Vault; org: string; admin: boolean } | ActionResult> {
  const org = formString(data, "org");
  if (!isUuid(org)) return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return fail("Switch to that organization first.");
  const vault = await viewerVault();
  if (!vault) return fail("The Armada server is not configured for this dashboard.");
  return { vault, org, admin: selected.role === "admin" };
}

function kindFrom(data: FormData): VaultKind | null {
  const kind = formString(data, "kind");
  return kind === "variable" || kind === "secret" ? kind : null;
}

function target(data: FormData): { id: string; expectedVersion: number } | null {
  const id = formString(data, "id");
  const expectedVersion = Number(formString(data, "version"));
  return isUuid(id) && Number.isSafeInteger(expectedVersion) && expectedVersion > 0 ? { id, expectedVersion } : null;
}

/** Runs one call; a refusal is said in words, without the server's generic text or anything that was sent. */
async function guarded(
  run: (context: { vault: Vault; org: string; admin: boolean }) => Promise<ActionResult>,
  data: FormData,
) {
  const context = await scoped(data);
  if ("ok" in context) return context;
  try {
    const result = await run(context);
    revalidatePath("/variables");
    return result;
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    // A refusal without a code is the transport's (signed out, unreachable, an older server): its words are right.
    return fail(error.code ? vaultFailure(error.status, error.message) : error.message);
  }
}

export async function addVaultItem(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ vault, org, admin }) => {
    const kind = kindFrom(data);
    if (!kind) return fail("Choose a variable or a secret.");
    const scope = formString(data, "scope");
    if (scope !== "personal" && scope !== "org") return fail("Choose who can use it.");
    if (scope === "org" && !admin) return fail("Only an admin adds organization variables and secrets.");
    const name = formString(data, "name").trim();
    const value = formString(data, "value");
    const problem = nameProblem(name, kind) ?? valueProblem(value, kind, name);
    if (problem) return fail(problem);
    const item = await vault.create(kind, { org, scope, name, value });
    return done(
      kind === "secret" ? `${item.name} is stored. Its value cannot be shown again.` : `${item.name} is saved.`,
    );
  }, data);
}

export async function updateVariable(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ vault, org }) => {
    const current = target(data);
    if (!current) return fail("That request is not valid.");
    const name = formString(data, "name").trim();
    const value = formString(data, "value");
    const problem = nameProblem(name, "variable") ?? valueProblem(value, "variable", name);
    if (problem) return fail(problem);
    const item = await vault.updateVariable({ org, ...current, name, value });
    return done(`${item.name} is saved.`);
  }, data);
}

export async function replaceSecret(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ vault, org }) => {
    const current = target(data);
    if (!current) return fail("That request is not valid.");
    const value = formString(data, "value");
    const problem = valueProblem(value, "secret", formString(data, "name"));
    if (problem) return fail(problem);
    const item = await vault.rotateSecret({ org, ...current, value });
    return done(`${item.name} has a new value (version ${item.version}).`);
  }, data);
}

export async function revokeVaultItem(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ vault, org }) => {
    const kind = kindFrom(data);
    const current = target(data);
    if (!kind || !current) return fail("That request is not valid.");
    const item = await vault.revoke(kind, { org, ...current });
    return done(`${item.name} is revoked.`);
  }, data);
}

export async function deleteVaultItem(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  return guarded(async ({ vault, org }) => {
    const kind = kindFrom(data);
    const current = target(data);
    if (!kind || !current) return fail("That request is not valid.");
    const item = await vault.delete(kind, { org, ...current });
    return done(`${item.name} is deleted.`);
  }, data);
}

/** A readable variable's value, on request: the list never carries one. Secrets have no such call. */
export async function readVariableValue(
  org: string,
  id: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (!isUuid(org) || !isUuid(id)) return { ok: false, error: "That request is not valid." };
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return { ok: false, error: "Switch to that organization first." };
  const vault = await viewerVault();
  if (!vault) return { ok: false, error: "The Armada server is not configured for this dashboard." };
  try {
    return { ok: true, value: await vault.readVariable({ org, id }) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { ok: false, error: error.code ? vaultFailure(error.status, error.message) : error.message };
  }
}
