"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import {
  CONNECTION_AUTH_TYPES,
  type ConnectionAuthType,
  type ConnectionTarget,
  checkBearer,
  checkHeaders,
  checkName,
  checkOAuthRegistration,
  checkServerUrl,
  checkStdio,
  completeUpdate,
  type EditedDefinition,
  type McpConnection,
  statusLabel,
} from "@/lib/connections";
import { ControlError } from "@/lib/control";
import { viewerControl } from "@/lib/data/connections";
import { selectedOrganization } from "@/lib/data/selected-org";

type Control = NonNullable<Awaited<ReturnType<typeof viewerControl>>>;
type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The control client and the selected org, once the form's org is the one the person is looking at. */
async function scoped(data: FormData): Promise<{ control: Control; org: string; admin: boolean } | ActionResult> {
  const org = formString(data, "org");
  if (!isUuid(org)) return fail("That request is not valid.");
  const selected = await selectedOrganization();
  if (selected?.org.id !== org) return fail("Switch to that organization first.");
  const control = await viewerControl();
  if (!control) return fail("The Armada server is not configured for this dashboard.");
  return { control, org, admin: selected.role === "admin" };
}

function isResult(value: object): value is ActionResult {
  return "ok" in value && ("message" in value || "error" in value);
}

function refresh() {
  revalidatePath("/connections");
  revalidatePath("/goldens");
}

/** What happened, from the connection the server returned: never a success the server did not report. */
function outcome(prefix: string, connection: McpConnection): ActionResult {
  if (connection.transport === "stdio") {
    return connection.status === "connected"
      ? done(`${prefix}${connection.name} is configured for launch.`)
      : fail(
          `${prefix}${connection.name}: ${statusLabel(connection)}.${connection.lastError ? ` ${connection.lastError}` : ""}`,
        );
  }
  if (connection.status === "connected") {
    const account = connection.accountLabel ? ` as ${connection.accountLabel}` : "";
    return done(`${prefix}${connection.name} is connected${account}.`);
  }
  const reason = connection.lastError ? ` ${connection.lastError}` : "";
  return fail(`${prefix}${connection.name}: ${statusLabel(connection)}.${reason}`);
}

function authTypeFrom(data: FormData): ConnectionAuthType | null {
  const value = formString(data, "auth_type");
  return (CONNECTION_AUTH_TYPES as readonly string[]).includes(value) ? (value as ConnectionAuthType) : null;
}

/**
 * The registry's opaque, write-only `authentication`: the raw bearer token, a JSON object of headers, or an
 * optional OAuth client preregistration. It is built here, sent once, and never read back.
 */
function authenticationFrom(data: FormData, authType: ConnectionAuthType): Checked<string | undefined> {
  switch (authType) {
    case "bearer":
      return checkBearer(formString(data, "bearer_token"));
    case "headers": {
      const headers = checkHeaders(data.getAll("header_name").map(String), data.getAll("header_value").map(String));
      return headers.ok ? { ok: true, value: JSON.stringify(headers.value) } : headers;
    }
    case "oauth":
      return checkOAuthRegistration(formString(data, "oauth_client_id"), formString(data, "oauth_client_secret"));
    default:
      return { ok: true, value: undefined };
  }
}

/** Starts a connection; an OAuth server sends the browser to its sign-in page and back to /connections. */
async function connectOrRedirect(control: Control, target: ConnectionTarget, prefix: string): Promise<ActionResult> {
  const { connection, authorizationUrl } = await control.connect(target);
  refresh();
  if (authorizationUrl) redirect(authorizationUrl);
  return outcome(prefix, connection);
}

async function guarded(run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ControlError) return fail(error.message);
    throw error;
  }
}

/** A connection's definition from the form: a remote URL with its authentication, or a stdio command. */
function definitionFrom(data: FormData): Checked<EditedDefinition> {
  if (formString(data, "kind") === "stdio") {
    // Armada passes no secret into a local process: a stdio server takes no authentication.
    const requested = formString(data, "auth_type");
    if (requested && requested !== "none") {
      return { ok: false, error: "stdio servers take no authentication in Armada. Use a remote URL for that server." };
    }
    const stdio = checkStdio(formString(data, "command"), formString(data, "args"));
    if (!stdio.ok) return stdio;
    return { ok: true, value: { transport: "stdio", authType: "none", ...stdio.value } };
  }
  const transport = formString(data, "transport");
  if (transport !== "http" && transport !== "sse") return { ok: false, error: "Choose the server's transport." };
  const url = checkServerUrl(formString(data, "url"));
  if (!url.ok) return url;
  const authType = authTypeFrom(data);
  if (!authType) return { ok: false, error: "Choose how Armada signs in to the server." };
  const authentication = authenticationFrom(data, authType);
  if (!authentication.ok) return authentication;
  return {
    ok: true,
    value: {
      transport,
      url: url.value,
      args: [],
      authType,
      ...(authentication.value === undefined ? {} : { authentication: authentication.value }),
    },
  };
}

/** Starts a remote connection, or configures a stdio one for launch, after a save. */
async function afterSave(control: Control, connection: McpConnection, org: string, prefix: string) {
  if (connection.transport === "stdio" && connection.status === "connected") return outcome(prefix, connection);
  return connectOrRedirect(control, { org, id: connection.id }, prefix);
}

/** Adds a remote (URL) or stdio connection to the selected org, personal or shared, then connects it. */
export async function addConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const { control, org, admin } = context;

  const scope = formString(data, "scope");
  if (scope !== "personal" && scope !== "org") return fail("Choose who the connection is for.");
  if (scope === "org" && !admin) return fail("Only an org admin adds org connections. Add it as personal instead.");
  const name = checkName(formString(data, "name"));
  if (!name.ok) return fail(name.error);
  const definition = definitionFrom(data);
  if (!definition.ok) return fail(definition.error);

  return guarded(async () => {
    const created = await control.create({ org, scope, name: name.value, ...definition.value });
    refresh();
    try {
      return await afterSave(control, created, org, "Added. ");
    } catch (error) {
      if (error instanceof ControlError)
        return fail(`${created.name} was added, but connecting failed: ${error.message}`);
      throw error;
    }
  });
}

function target(data: FormData, org: string): ConnectionTarget | null {
  const id = formString(data, "id");
  return isUuid(id) ? { org, id } : null;
}

/**
 * Edits a connection. The registry's save is a full replace: the complete definition is sent, with the scope of
 * the stored connection read server-side (never from the form), and every saved authentication is cleared. A
 * remote connection is then connected again; a stdio one is configured for launch again.
 */
export async function editConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  if (!chosen) return fail("That request is not valid.");
  const name = checkName(formString(data, "name"));
  if (!name.ok) return fail(name.error);
  const definition = definitionFrom(data);
  if (!definition.ok) return fail(definition.error);

  return guarded(async () => {
    const current = await context.control.status(chosen);
    const request = completeUpdate(current, name.value, definition.value);
    if (!request.ok) return fail(request.error);
    const updated = await context.control.update({ org: context.org, ...request.value });
    refresh();
    try {
      return await afterSave(context.control, updated, context.org, "Saved. ");
    } catch (error) {
      if (error instanceof ControlError) {
        return fail(`Saved. Its previous authorization was cleared, and reconnecting failed: ${error.message}`);
      }
      throw error;
    }
  });
}

/** Connects or reconnects one connection; OAuth goes through the server's browser sign-in. */
export async function connectConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  if (!chosen) return fail("That request is not valid.");
  return guarded(() => connectOrRedirect(context.control, chosen, ""));
}

/** Asks the server to check the connection again and reports what it found. */
export async function checkConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  if (!chosen) return fail("That request is not valid.");
  return guarded(async () => {
    const connection = await context.control.status(chosen);
    refresh();
    return outcome("", connection);
  });
}

/** Drops the stored authorization (tokens, header values); the definition stays, ready to connect again. */
export async function revokeConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  if (!chosen) return fail("That request is not valid.");
  return guarded(async () => {
    await context.control.revoke(chosen);
    refresh();
    return done("Access revoked. Connect again to use it.");
  });
}

/** Removes the connection and its stored authorization. */
export async function deleteConnection(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  if (!chosen) return fail("That request is not valid.");
  return guarded(async () => {
    await context.control.delete(chosen);
    refresh();
    return done("Connection deleted.");
  });
}

/** Turns a connection off for new launches, or back on (`POST mcp/set-enabled`). Its authorization is kept. */
export async function setConnectionEnabled(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (isResult(context)) return context;
  const chosen = target(data, context.org);
  const enabled = formString(data, "enabled");
  if (!chosen || (enabled !== "true" && enabled !== "false")) return fail("That request is not valid.");
  return guarded(async () => {
    const connection = await context.control.setEnabled({ ...chosen, enabled: enabled === "true" });
    refresh();
    if (enabled === "false") {
      return connection.status === "disabled"
        ? done(`${connection.name} is disabled. New launches cannot select it.`)
        : fail(`${connection.name} was not disabled: ${statusLabel(connection)}.`);
    }
    return connection.status === "disabled"
      ? fail(`${connection.name} is still disabled.`)
      : done(
          connection.status === "connected"
            ? `${connection.name} is enabled.`
            : `${connection.name} is enabled. ${statusLabel(connection)}: connect it before launching.`,
        );
  });
}
