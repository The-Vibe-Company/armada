"use server";

import { parseCredentialValue, VaultError } from "@armada/core";
import { revalidatePath } from "next/cache";
import type { AccountControl, AccountTarget } from "@/lib/account-control";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { viewerAccountControl } from "@/lib/data/model-accounts";
import { selectedOrganization } from "@/lib/data/selected-org";
import {
  ACCOUNT_KINDS,
  type AccountKind,
  type AccountScope,
  checkAccountName,
  checkDefaultChoice,
  HARNESS_PATH,
  KIND_INFO,
} from "@/lib/model-accounts";
import { customAccountValue, replacementCodexAccountValue } from "@/lib/model-connection-input";

type Scoped = { control: AccountControl; scope: AccountScope; org: string };

/**
 * The control client and the scope the form names. An org account belongs to the org the person is looking at,
 * so its form must name that org; the server checks the admin role itself.
 */
async function scoped(data: FormData): Promise<Scoped | ActionResult> {
  const scope = formString(data, "scope");
  if (scope !== "user" && scope !== "org") return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (!selected) return fail("Create an organization first.");
  if (scope === "org" && formString(data, "org") !== selected.org.id) return fail("Switch to that organization first.");
  const control = await viewerAccountControl();
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  return { control, scope, org: selected.org.id };
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
  if (error.status === 409 || error.code === "conflict")
    return fail("This account changed elsewhere. Reload the page and try again.");
  return fail(error.message);
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
  revalidatePath("/environments");
}

/** Adds a named account from a pasted token, key or auth.json, and makes it the default when asked. */
export async function addAccount(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const kind = formString(data, "kind");
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) return fail("Choose what you are adding.");
  const name = checkAccountName(data.get("name"));
  if (!name.ok) return fail(name.error);
  const value =
    data.get("customEndpoint") === "on"
      ? customAccountValue(kind as AccountKind, data)
      : secret(kind as AccountKind, data.get("value"));
  if (!value.ok) return fail(value.error);

  let saved: Awaited<ReturnType<AccountControl["set"]>>;
  try {
    saved = await context.control.set({
      ...(context.scope === "org" ? { org: context.org } : {}),
      scope: context.scope,
      kind,
      name: name.value,
      value: value.value,
    });
  } catch (error) {
    return explain(error);
  }
  refresh();
  if (data.get("default") === "on" && !saved.isDefault) {
    try {
      await context.control.makeDefault(target(context, saved.id));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      return fail(`${saved.name} was saved, but not made the default: ${error.message}`);
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
  const value = kind === "openai" ? replacementCodexAccountValue(data) : secret(kind as AccountKind, data.get("value"));
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
    return done(`${saved.name} is now the default for ${KIND_INFO[saved.kind].harnessLabel}.`);
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

/** Inspect or release a failed subscription launch; authorization stays on the server. */
export async function subscriptionHolder(data: FormData): Promise<{
  sandboxId: string | null;
  releasable?: boolean;
  requiresReconnect?: boolean;
  orphan?: boolean;
  unknownVersion?: boolean;
  error?: string;
}> {
  const context = await scoped(data);
  if (!isScoped(context)) return { sandboxId: null, error: "Account control unavailable." };
  try {
    const result = await context.control.holder({
      ...target(context, formString(data, "id")),
      version: version(data) ?? -1,
      org: context.org,
    });
    return {
      sandboxId: typeof result.sandboxId === "string" ? result.sandboxId : null,
      releasable: result.releasable === true,
      requiresReconnect: result.requiresReconnect === true,
      orphan: result.orphan === true,
      unknownVersion: result.unknownVersion === true,
    };
  } catch (error) {
    if (error instanceof ControlError) return { sandboxId: null, error: error.message };
    throw error;
  }
}

export async function releaseSubscription(data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  try {
    await context.control.release({
      ...target(context, formString(data, "id")),
      sandboxId: formString(data, "sandboxId"),
      version: version(data) ?? -1,
      org: context.org,
    });
    refresh();
    return done("Subscription released. You can launch again.");
  } catch (error) {
    if (error instanceof ControlError) return fail(error.message);
    throw error;
  }
}

/** Atomically reconnect legacy history lacking a version and release its deleted holder. */
export async function reconnectAndReleaseSubscription(
  _previous: ActionResult | null,
  data: FormData,
): Promise<ActionResult> {
  const context = await scoped(data);
  if (!isScoped(context)) return context;
  const value = secret("codex_auth", data.get("value"));
  if (!value.ok) return fail(value.error);
  try {
    await context.control.release({
      ...target(context, formString(data, "id")),
      org: context.org,
      version: version(data) ?? -1,
      sandboxId: formString(data, "sandboxId"),
      value: value.value,
    });
    refresh();
    return done("Subscription released. You can launch again.");
  } catch (error) {
    if (error instanceof ControlError) return fail(error.message);
    throw error;
  }
}
