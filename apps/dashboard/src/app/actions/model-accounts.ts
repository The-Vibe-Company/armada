"use server";

import { HARNESSES, type Harness, parseCredentialValue, resolveModelChoice, VaultError } from "@armada/core";
import { revalidatePath } from "next/cache";
import type { AccountControl, AccountTarget } from "@/lib/account-control";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { antigravityMethod, GOOGLE_CODE_ERROR, googleCode, googleSignInFailure } from "@/lib/antigravity-account";
import { ControlError } from "@/lib/control";
import { listSelectedAccounts, viewerAccountControl } from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import {
  ACCOUNT_KINDS,
  type AccountKind,
  type AccountScope,
  checkAccountName,
  checkDefaultChoice,
  HARNESS_PATH,
  KIND_INFO,
  modelAccountFailure,
  parseAccountAgentLimit,
} from "@/lib/model-accounts";
import { connectionTestOutcome, matchesConnectionTestSandbox } from "@/lib/model-connection-check";
import {
  customAccountValue,
  morphAccountValue,
  presetAccountValue,
  presetReplacementValue,
  replacementClaudeAccountValue,
  replacementCodexAccountValue,
  replacementOpenCodeAccountValue,
} from "@/lib/model-connection-input";
import { createClient } from "@/lib/supabase/server";

type Scoped = { control: AccountControl; scope: AccountScope; org: string };

/**
 * The control client and the scope the form names. An org account belongs to the org the person is looking at,
 * so its form must name that org; the server checks the admin role itself.
 */
async function scoped(data: FormData) {
  const scope = formString(data, "scope");
  if (scope !== "user" && scope !== "org") return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (!selected) return fail("Create an organization first.");
  if (scope === "org" && formString(data, "org") !== selected.org.id) return fail("Switch to that organization first.");
  const control = await viewerAccountControl();
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  return { control, scope, org: selected.org.id } satisfies Scoped;
}

function target(context: Scoped, id: string): AccountTarget {
  return context.scope === "org" ? { scope: "org", org: context.org, id } : { scope: "user", id };
}

function isScoped(value: Scoped | ActionResult): value is Scoped {
  return "control" in value;
}

function version(data: FormData): number | null {
  const value = Number(formString(data, "version"));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** The control API's failure in words for the person; a stale version is a change made elsewhere. */
function explain(error: unknown): ActionResult {
  if (!(error instanceof ControlError)) throw error;
  return fail(modelAccountFailure(error.status, error.code));
}

/** A pasted secret, checked by the server's own parser. The error never repeats the value. */
function secret(kind: AccountKind, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Paste the value to store." };
  try {
    return { ok: true, value: parseCredentialValue(kind, raw) };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}

function refresh() {
  revalidatePath(HARNESS_PATH);
  revalidatePath("/snapshots");
}

export async function startGoogleSignIn(data: FormData) {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const name = checkAccountName(data.get("name"));
  if (!name.ok) return fail(name.error);
  try {
    const login = await context.control.startGoogleSignIn({
      name: name.value,
      ...(context.scope === "org" ? { org: context.org } : {}),
    });
    return { ok: true as const, ...login };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(googleSignInFailure("start", error.status, error.code));
  }
}

export async function cancelGoogleSignIn(data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "loginId");
  if (!isUuid(id)) return fail("That request is not valid.");
  try {
    await context.control.cancelGoogleSignIn(id);
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    if (error.code !== "not_found") return explain(error);
  }
  return done("Google sign-in cancelled.");
}

async function completeGoogleSignIn(context: Scoped, data: FormData, maxAgents: number | null) {
  const id = formString(data, "loginId");
  if (!isUuid(id)) return fail("Start sign-in again.");
  const code = googleCode(data.get("code"));
  if (!code) return fail(GOOGLE_CODE_ERROR);
  let account: Awaited<ReturnType<AccountControl["completeGoogleSignIn"]>>;
  try {
    account = await context.control.completeGoogleSignIn(id, code);
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(googleSignInFailure("complete", error.status, error.code));
  }
  if (maxAgents !== null) {
    try {
      await context.control.limits({ ...target(context, account.id), maxAgents });
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      refresh();
      return {
        ...fail(`${account.name} was saved. Open the account in Models to check its agent limit and default settings.`),
        accountSaved: true as const,
      };
    }
  }
  return finishAccountSetup(context, data, account);
}

/** Adds a named account from a pasted token, key or auth.json, and makes it the default when asked. */
export async function addAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const preset = formString(data, "preset");
  const fromPreset = preset ? presetAccountValue(data) : null;
  if (fromPreset && !fromPreset.ok) return fail(fromPreset.error);
  // A provider preset decides the kind; the form's own kind is ignored for it.
  const kind = fromPreset?.ok ? fromPreset.kind : formString(data, "kind");
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) return fail("Choose what you are adding.");
  const name = checkAccountName(data.get("name"));
  if (!name.ok) return fail(name.error);
  const method = kind === "antigravity" ? antigravityMethod(data.get("antigravityMethod")) : undefined;
  if (kind === "antigravity" && !method) return fail("Choose an Antigravity connection method.");
  const maxAgents = parseAccountAgentLimit(formString(data, "maxAgents"));
  if (maxAgents === undefined)
    return fail("Enter a maximum of 1 to 2,147,483,647 agents, or leave it empty for unlimited.");
  if (method === "google") return completeGoogleSignIn(context, data, maxAgents);
  const raw =
    method === "gemini-api-key"
      ? JSON.stringify({ method, apiKey: formString(data, "value").trim() })
      : data.get("value");
  const value =
    fromPreset ??
    (kind === "morph"
      ? morphAccountValue(data)
      : data.get("customEndpoint") === "on"
        ? customAccountValue(kind as AccountKind, data)
        : secret(kind as AccountKind, raw));
  if (!value.ok) return fail(value.error);

  let saved: Awaited<ReturnType<AccountControl["set"]>>;
  try {
    saved = await context.control.set({
      ...(context.scope === "org" ? { org: context.org } : {}),
      scope: context.scope,
      kind,
      name: name.value,
      value: value.value,
      maxAgents,
    });
  } catch (error) {
    return explain(error);
  }
  return finishAccountSetup(context, data, saved);
}

async function finishAccountSetup(
  context: Scoped,
  data: FormData,
  saved: Pick<Awaited<ReturnType<AccountControl["set"]>>, "id" | "kind" | "name"> & { isDefault?: boolean },
) {
  refresh();
  if (data.get("default") === "on" && !saved.isDefault) {
    try {
      await context.control.makeDefault(target(context, saved.id));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      const recovery =
        error.status === 401
          ? "Sign in again, then reload Models."
          : "Reload Models and check the saved account before adding another.";
      return {
        ...fail(`${saved.name} was saved, but its default setting is unconfirmed. ${recovery}`),
        accountSaved: true as const,
      };
    }
    return done(`${saved.name} saved as the default ${KIND_INFO[saved.kind].harnessLabel} account.`);
  }
  return done(`${saved.name} saved.`);
}

/** Replaces an account's secret (a new token for the same account). Its id, name and default stay. */
export async function replaceAccountSecret(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "id");
  const expectedVersion = version(data);
  const kind = formString(data, "kind");
  if (!isUuid(id) || expectedVersion === null || !(ACCOUNT_KINDS as readonly string[]).includes(kind))
    return fail("That request is not valid.");
  const name = checkAccountName(data.get("name"));
  if (!name.ok) return fail(name.error);
  // A provider preset re-enters the whole connection; it must keep the account's kind.
  const fromPreset = formString(data, "preset") ? presetReplacementValue(data, kind as AccountKind) : null;
  const value =
    fromPreset ??
    (kind === "openai"
      ? replacementCodexAccountValue(data)
      : kind === "anthropic"
        ? replacementClaudeAccountValue(data)
        : kind === "opencode"
          ? replacementOpenCodeAccountValue(data)
          : kind === "morph"
            ? morphAccountValue(data, { replacing: true })
            : secret(kind as AccountKind, data.get("value")));
  if (!value.ok) return fail(value.error);
  try {
    const saved = await context.control.set({
      ...target(context, id),
      kind,
      name: name.value,
      value: value.value,
      expectedVersion,
    });
    refresh();
    return done(`${saved.name} updated.`);
  } catch (error) {
    return explain(error);
  }
}

export async function renameAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  const name = checkAccountName(data.get("name"));
  if (!name.ok) return fail(name.error);
  try {
    const saved = await context.control.rename({ ...target(context, id), name: name.value });
    refresh();
    return done(`Renamed to ${saved.name}.`);
  } catch (error) {
    return explain(error);
  }
}

export async function makeDefaultAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  try {
    // A default that cannot run would refuse every launch that names no account, so it is checked first.
    const { accounts } = await context.control.list(context.org);
    const allowed = checkDefaultChoice(accounts, id, Date.now());
    if (!allowed.ok) return fail(allowed.error);
    const saved = await context.control.makeDefault(target(context, id));
    refresh();
    return done(
      `${saved.name} is now the ${saved.scope === "org" ? "organization" : "personal"} default for ${KIND_INFO[saved.kind].harnessLabel}.`,
    );
  } catch (error) {
    return explain(error);
  }
}

export async function removeAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "id");
  if (!isUuid(id)) return fail("That request is not valid.");
  try {
    await context.control.remove(target(context, id));
  } catch (error) {
    return explain(error);
  }
  refresh();
  return done("Account removed.");
}

/** A tiny runtime check: no secret input and no automatic machine launch/resume. */
export async function testAccountConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const accountId = formString(data, "id");
  const sandboxId = formString(data, "sandboxId");
  const revision = version(data);
  const model = formString(data, "model");
  if (!isUuid(accountId) || !isUuid(sandboxId) || revision === null || revision < 1 || !model || model.length > 200)
    return fail("Choose a running sandbox and enter the deployment or model name.");
  const viewer = await requireViewer();
  const supabase = await createClient();
  const { data: sandbox, error } = await supabase
    .from("sandboxes")
    .select("id,owner_id,org_id,provider,boat_runtime,status,stop_requested_at,credential_id,credential_version")
    .eq("id", sandboxId)
    .eq("owner_id", viewer.id)
    .eq("org_id", context.org)
    .maybeSingle();
  if (
    error ||
    !matchesConnectionTestSandbox(sandbox, {
      id: sandboxId,
      ownerId: viewer.id,
      orgId: context.org,
      accountId,
      version: revision,
    })
  )
    return fail(
      "That sandbox is no longer available for this account. Reload Models and choose a matching running sandbox. No machine was started or resumed.",
    );
  try {
    return connectionTestOutcome(await context.control.testConnection({ id: sandboxId, model, org: context.org }));
  } catch (error) {
    if (error instanceof ControlError)
      return fail("The check could not be completed. Check the sandbox and your connection before trying again.");
    throw error;
  }
}

export async function updateAccountLimits(_previous: ActionResult | null, data: FormData) {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const id = formString(data, "id");
  const maxAgents = parseAccountAgentLimit(formString(data, "maxAgents"));
  if (!isUuid(id) || maxAgents === undefined)
    return fail("Enter a maximum of 1 to 2,147,483,647 agents, or leave it empty for unlimited.");
  try {
    const saved = await context.control.limits({
      ...target(context, id),
      maxAgents,
      ...(formString(data, "model").trim() ? { model: formString(data, "model").trim() } : {}),
    });
    refresh();
    return done(`${saved.name} limit updated.`);
  } catch (error) {
    return explain(error);
  }
}

/** Safe metadata only, for a subscription dialog waiting for a CLI import. */
export async function pollModelAccounts(orgId: string) {
  const list = await listSelectedAccounts();
  if (list.state !== "ready" || list.orgId !== orgId) return null;
  return list.accounts.map(({ id, version, kind, scope, name }) => ({ id, version, kind, scope, name }));
}

/** Personal selections never mutate organization-owned accounts. */
export async function setPersonalAgentDefault(_previous: ActionResult | null, data: FormData) {
  const selected = await selectedOrganization();
  if (!selected || formString(data, "org") !== selected.org.id) return fail("Switch to that organization first.");
  const harness = formString(data, "harness") as Harness;
  const credentialId = formString(data, "credentialId") || null;
  const model = formString(data, "model") || null;
  if (!HARNESSES.includes(harness) || (credentialId !== null && !isUuid(credentialId)))
    return fail("Choose a compatible account.");
  try {
    if (model) resolveModelChoice(harness, { model });
    const control = await viewerAccountControl();
    if (!control) return fail("Account management is not configured.");
    await control.setAgentDefault({ org: selected.org.id, harness, credentialId, model });
    refresh();
    return done("Personal launch default updated.");
  } catch (error) {
    if (error instanceof ControlError) return explain(error);
    if (error instanceof Error && error.name === "LaunchError") return fail("Choose a valid model for this agent.");
    throw error;
  }
}
