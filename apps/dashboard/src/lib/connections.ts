/**
 * MCP connections as the dashboard sees them: the public DTO of the control API
 * (`POST /api/control/mcp/{list,create,update,connect,status,revoke,delete}`, issue #522), the request
 * bodies the dashboard sends, and the form rules that run before a request leaves the dashboard.
 *
 * These are narrow app interfaces matching the frozen contract, so the dashboard compiles on its own; the
 * canonical backend types replace them when the registry lands. Authentication values (a bearer token,
 * header values) only ever travel in request bodies: no DTO carries them back.
 */

export const CONNECTION_SCOPES = ["personal", "org"] as const;
export const CONNECTION_TRANSPORTS = ["http", "sse", "stdio"] as const;
/**
 * `auto` (the default) asks the server to probe the URL and resolve to `none` or `oauth`; until that probe ran a
 * connection stays `not_connected`. `bearer` and `headers` are explicit overrides with write-only values.
 */
export const CONNECTION_AUTH_TYPES = ["auto", "none", "bearer", "headers", "oauth"] as const;
export const CONNECTION_STATUSES = [
  "connected",
  "not_connected",
  "needs_reconnect",
  "unavailable",
  "disabled",
] as const;
export const SANDBOX_VISIBILITIES = ["private", "org"] as const;

export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];
export type ConnectionTransport = (typeof CONNECTION_TRANSPORTS)[number];
export type ConnectionAuthType = (typeof CONNECTION_AUTH_TYPES)[number];
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export type SandboxVisibility = (typeof SANDBOX_VISIBILITIES)[number];

/** The public connection DTO. `url` is already redacted for display by the server; `lastError` is sanitized. */
export interface McpConnection {
  id: string;
  name: string;
  orgId: string;
  scope: ConnectionScope;
  transport: ConnectionTransport;
  url?: string;
  command?: string;
  args?: string[];
  authType: ConnectionAuthType;
  status: ConnectionStatus;
  accountLabel?: string;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  lastError?: string;
  /**
   * The curated service this connection was created from (`mcp/catalog`), or absent for a custom server. Several
   * connections may share one service: the connection `id` is the only identity, never the service or the name.
   */
  catalogId?: string;
  /** Whether a launch that names no connections includes this one. Metadata only: it never touches authorization. */
  defaultForLaunch: boolean;
}

/**
 * The registry's write-only, opaque `authentication` string: the raw bearer token for `bearer`, a JSON object
 * of header names to values for `headers`, or an optional OAuth client preregistration JSON for `oauth`.
 * Sent on create or update, never returned.
 */
/**
 * The registry's complete `McpConnectionInput`. Create and update both send all of it: update is a full replace
 * whose `scope` must restate the stored one (it is immutable), and it clears every saved authentication.
 */
export type ConnectionDefinition = {
  scope: ConnectionScope;
  name: string;
  transport: ConnectionTransport;
  url?: string;
  command?: string;
  args: string[];
  authType: ConnectionAuthType;
  authentication?: string;
};

export type CreateConnectionRequest = { org: string } & ConnectionDefinition;

export type UpdateConnectionRequest = { org: string; id: string } & ConnectionDefinition;

/** A definition from the form, before the stored scope is added: a remote URL or a stdio command. */
export type EditedDefinition = Omit<ConnectionDefinition, "scope" | "name">;

/**
 * The full-replace update for an edit. Scope comes from the stored connection the server returned, never from
 * the form; a remote connection stays remote and a stdio one stays stdio (anything else is a new connection).
 */
export function completeUpdate(
  current: McpConnection,
  name: string,
  edited: EditedDefinition,
): Parsed<Omit<UpdateConnectionRequest, "org">> {
  if ((current.transport === "stdio") !== (edited.transport === "stdio")) {
    return { ok: false, error: "A remote connection stays remote and a stdio one stays stdio. Add a new one instead." };
  }
  return { ok: true, value: { id: current.id, scope: current.scope, name, ...edited } };
}

export type ConnectionTarget = { org: string; id: string };

/** `POST mcp/create` from the catalog: the server resolves the service's canonical URL and authentication. */
export type CreateFromCatalogRequest = { org: string; scope: ConnectionScope; name: string; serviceId: string };

/**
 * `POST mcp/metadata`: renames a connection or changes whether launches include it by default. Unlike `update`
 * and `set-enabled`, it keeps the stored authorization, the pending sign-in and running sandboxes' access.
 */
export type ConnectionMetadataRequest = ConnectionTarget & { name?: string; defaultForLaunch?: boolean };

/**
 * One curated service of `POST mcp/catalog`, as the server reports it for this deployment. `available` means
 * Armada can sign in to it now; anything else is setup the deployment still needs, and the dashboard offers no
 * Connect.
 */
export interface McpCatalogService {
  id: string;
  label: string;
  url: string;
  docsUrl?: string;
  availability: "available" | "setup_required";
  setupMessage?: string;
}

const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A catalog entry from the control API, or null when it does not match the contract. */
export function parseCatalogService(value: unknown): McpCatalogService | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !SERVICE_ID.test(value.id)) return null;
  const label = text(value.label, 80);
  const url = safeAuthorizationUrl(value.url);
  if (!label || !url) return null;
  const docsUrl = safeAuthorizationUrl(value.docsUrl);
  const setupMessage = text(value.setupMessage, 300);
  return {
    id: value.id,
    label,
    url,
    ...(docsUrl ? { docsUrl } : {}),
    // Only an explicit `available` offers Connect: an unknown or missing availability is never shown as usable.
    availability: value.availability === "available" ? "available" : "setup_required",
    ...(setupMessage ? { setupMessage } : {}),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 120;
const MAX_SECRET = 16 * 1024;
/** RFC 7230 token characters: a header name the server can forward as is. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the transport owns; a connection may not set them. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
]);

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, max = 2_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

/**
 * A DTO from the control API, or null when it does not match the contract. Only the named fields are kept,
 * so a field the server should not have sent is never rendered.
 */
export function parseConnection(value: unknown): McpConnection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !UUID.test(row.id)) return null;
  if (typeof row.orgId !== "string" || !UUID.test(row.orgId)) return null;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  if (!oneOf(CONNECTION_SCOPES, row.scope) || !oneOf(CONNECTION_TRANSPORTS, row.transport)) return null;
  if (!oneOf(CONNECTION_AUTH_TYPES, row.authType) || !oneOf(CONNECTION_STATUSES, row.status)) return null;
  const args = Array.isArray(row.args) ? row.args.filter((item): item is string => typeof item === "string") : [];
  const connection: McpConnection = {
    id: row.id,
    name: row.name.slice(0, MAX_NAME),
    orgId: row.orgId,
    scope: row.scope,
    transport: row.transport,
    authType: row.authType,
    status: row.status,
    defaultForLaunch: row.defaultForLaunch === true,
  };
  const optional = {
    catalogId: typeof row.catalogId === "string" && SERVICE_ID.test(row.catalogId) ? row.catalogId : undefined,
    url: text(row.url),
    command: text(row.command, 500),
    args: args.length ? args : undefined,
    accountLabel: text(row.accountLabel, 200),
    toolCount: count(row.toolCount),
    resourceCount: count(row.resourceCount),
    promptCount: count(row.promptCount),
    lastError: text(row.lastError, 500),
  };
  for (const [key, entry] of Object.entries(optional)) {
    if (entry !== undefined) Object.assign(connection, { [key]: entry });
  }
  return connection;
}

/** What a person reads for a status, and whether a launch can use the connection now. */
export const STATUS_INFO: Record<ConnectionStatus, { label: string; tone: "ok" | "warn" | "error" | "muted" }> = {
  connected: { label: "Connected", tone: "ok" },
  not_connected: { label: "Not connected", tone: "muted" },
  needs_reconnect: { label: "Needs reconnect", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "error" },
  disabled: { label: "Disabled", tone: "muted" },
};

/**
 * A status as the person reads it. A stdio connection is never probed by Armada: `connected` means its pinned
 * definition is configured for launch, and the process only starts inside each sandbox.
 */
export function statusLabel(connection: Pick<McpConnection, "status" | "transport">): string {
  if (connection.transport === "stdio") {
    if (connection.status === "connected") return "Configured for launch";
    if (connection.status === "not_connected") return "Not configured";
  }
  return STATUS_INFO[connection.status].label;
}

/**
 * The one action that moves a connection toward usable, by its state: sign in for the first time, sign in again
 * after the grant lapsed, or try again after the server could not be reached. Null when nothing needs doing.
 */
export function connectAction(
  connection: Pick<McpConnection, "status" | "transport" | "authType">,
): "Connect" | "Reconnect" | "Retry" | "Configure" | null {
  if (connection.status === "disabled") return null;
  if (connection.transport === "stdio") return connection.status === "connected" ? null : "Configure";
  if (connection.status === "needs_reconnect") return "Reconnect";
  if (connection.status === "unavailable") return "Retry";
  if (connection.status === "not_connected") return "Connect";
  return null;
}

export function isLaunchable(connection: McpConnection): boolean {
  return connection.status === "connected";
}

/** Why a connection cannot be picked for a launch of the given visibility, or null when it can. */
export function launchBlocker(connection: McpConnection, visibility: SandboxVisibility): string | null {
  if (!isLaunchable(connection)) {
    return connection.status === "disabled"
      ? "Disabled. Enable it on the Connections page first."
      : connection.transport === "stdio"
        ? `${statusLabel(connection)}. Configure it on the Connections page first.`
        : `${statusLabel(connection)}. Connect it on the Connections page first.`;
  }
  if (connection.scope === "personal" && visibility === "org") {
    return "Personal: uses your own account, so it needs a private sandbox.";
  }
  return null;
}

/**
 * The connections a new launch starts with: those marked include-by-default that it can actually use at this
 * visibility. A personal default never enters an org-visible sandbox, and one that is not connected is left for
 * the person to fix rather than silently sent.
 */
export function launchDefaults(available: readonly McpConnection[], visibility: SandboxVisibility): string[] {
  return available
    .filter((connection) => connection.defaultForLaunch && launchBlocker(connection, visibility) === null)
    .map((connection) => connection.id);
}

/**
 * Defaults this launch would get but cannot use yet: enabled, allowed at this visibility, and not connected. The
 * server refuses a launch that omits connections while such a default exists, so the dialog names them instead of
 * dropping them silently, and launches without them only once the person chooses to.
 */
export function unreadyDefaults(available: readonly McpConnection[], visibility: SandboxVisibility): McpConnection[] {
  return available.filter(
    (connection) =>
      connection.defaultForLaunch &&
      connection.status !== "disabled" &&
      !isLaunchable(connection) &&
      !(connection.scope === "personal" && visibility === "org"),
  );
}

/**
 * The launch's visibility and connections, checked against what the control API listed for the selected org.
 * The server enforces the same rules; this check explains them before a launch is attempted.
 */
export function launchSelection(input: {
  visibility: string;
  connections: string[];
  goldenVisibility: SandboxVisibility;
  available: readonly McpConnection[];
}): Parsed<{ visibility: SandboxVisibility; connections: string[] }> {
  if (!oneOf(SANDBOX_VISIBILITIES, input.visibility)) return { ok: false, error: "Choose who can see the sandbox." };
  if (input.visibility === "org" && input.goldenVisibility === "private") {
    return { ok: false, error: "A sandbox from a private golden stays private." };
  }
  const ids = [...new Set(input.connections)];
  for (const id of ids) {
    const connection = input.available.find((item) => item.id === id);
    if (!connection) return { ok: false, error: "A selected connection is no longer available. Reload and try again." };
    const blocker = launchBlocker(connection, input.visibility);
    if (blocker) return { ok: false, error: `${connection.name}: ${blocker}` };
  }
  return { ok: true, value: { visibility: input.visibility, connections: ids } };
}

/** An absolute http(s) URL without credentials in it; a secret belongs in the write-only fields. */
export function checkServerUrl(raw: string): Parsed<string> {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Enter the full server URL, starting with https://." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    return { ok: false, error: "Use an https:// URL. Plain http is only accepted for localhost." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Remove the user name or password from the URL; use a bearer token or headers." };
  }
  if (url.hash) return { ok: false, error: "Remove the #fragment from the URL." };
  const secret = [...url.searchParams.keys()].find(isCredentialParam);
  if (secret) {
    return {
      ok: false,
      error: `Remove "${secret.slice(0, 40)}" from the URL: a credential belongs in the bearer token or headers, which are stored encrypted.`,
    };
  }
  return { ok: true, value: url.toString() };
}

/**
 * Query parameter names that carry a credential. Ordinary parameters (such as Supabase's `project_ref` or
 * `read_only`) are kept: only these are refused, because a URL is shown to everyone who can use the connection.
 */
const CREDENTIAL_PARAM =
  /^(?:.*[_-])?(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|bearer|credentials?|sig|signature|session)$/i;

function isCredentialParam(name: string): boolean {
  return CREDENTIAL_PARAM.test(name.trim());
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The authorization URL the control API returned for a browser sign-in, if it is safe to send the browser to:
 * https (or loopback http), no embedded credentials. The server validated the issuer; this is the second check.
 */
export function safeAuthorizationUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) return url.toString();
    return null;
  } catch {
    return null;
  }
}

/** A suggested name for a new connection to a service, distinct from the names already in use. */
export function suggestedName(label: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let index = 2; ; index++) {
    const candidate = `${label} ${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function checkName(raw: string): Parsed<string> {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Name the connection." };
  if (name.length > MAX_NAME) return { ok: false, error: `Keep the name under ${MAX_NAME} characters.` };
  return { ok: true, value: name };
}

/** Header rows from the form: names are checked, values stay write-only and are never echoed back. */
export function checkHeaders(names: string[], values: string[]): Parsed<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [index, rawName] of names.entries()) {
    const name = rawName.trim();
    const value = values[index] ?? "";
    if (!name && !value) continue;
    if (!HEADER_NAME.test(name)) return { ok: false, error: `"${name.slice(0, 40)}" is not a valid header name.` };
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return { ok: false, error: `${name} is set by the connection itself.` };
    }
    if (!value) return { ok: false, error: `Enter a value for ${name}.` };
    if (/[\r\n]/.test(value) || value.length > MAX_SECRET) {
      return { ok: false, error: `The value for ${name} is not valid.` };
    }
    if (Object.keys(headers).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `${name} is listed twice.` };
    }
    headers[name] = value;
  }
  if (Object.keys(headers).length === 0) return { ok: false, error: "Add at least one header." };
  return { ok: true, value: headers };
}

/**
 * Optional OAuth client preregistration, for a server that offers neither client metadata documents nor dynamic
 * registration. Empty fields mean none: the server discovers how to register.
 */
export function checkOAuthRegistration(clientId: string, clientSecret: string): Parsed<string | undefined> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id && !secret) return { ok: true, value: undefined };
  if (!id) return { ok: false, error: "Enter the client ID that goes with the client secret." };
  if (/\s/.test(id) || id.length > 500 || secret.length > MAX_SECRET) {
    return { ok: false, error: "That client registration is not valid." };
  }
  return { ok: true, value: JSON.stringify(secret ? { client_id: id, client_secret: secret } : { client_id: id }) };
}

export function checkBearer(raw: string): Parsed<string> {
  const value = raw.trim().replace(/^Bearer\s+/i, "");
  if (!value) return { ok: false, error: "Paste the token." };
  if (/\s/.test(value) || value.length > MAX_SECRET) return { ok: false, error: "That token is not valid." };
  return { ok: true, value };
}

/** Package runners whose package argument must carry an exact version, so every sandbox runs the same code. */
const RUNNERS: Record<string, { label: string; example: string }> = {
  npx: { label: "npm", example: "@modelcontextprotocol/server-filesystem@2026.1.14" },
  bunx: { label: "npm", example: "@modelcontextprotocol/server-filesystem@2026.1.14" },
  uvx: { label: "PyPI", example: "mcp-server-git==2026.1.14" },
};
/** Flags of the runners that take the package as their value. */
const PACKAGE_FLAGS = new Set(["-p", "--package", "--from"]);
const NPM_EXACT = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i;
const PYPI_EXACT = /^[A-Za-z0-9][\w.-]*(?:\[[\w,.-]+\])?(?:==|@)\d+(?:\.\d+)*(?:[-.+]?[0-9A-Za-z.]+)?$/;

/** The package spec a runner would install, or null when there is none to check. */
function packageSpec(args: readonly string[]): string | null {
  for (const [index, arg] of args.entries()) {
    const [flag, inline] = arg.split("=", 2);
    if (flag && PACKAGE_FLAGS.has(flag)) return inline ?? args[index + 1] ?? null;
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

/**
 * A stdio server's command and arguments. The command is one executable (no shell); a package runner must
 * name an exact version. Secrets have no place here: the definition is visible to everyone who can use it.
 */
export function checkStdio(rawCommand: string, rawArgs: string): Parsed<{ command: string; args: string[] }> {
  const command = rawCommand.trim();
  if (!command) return { ok: false, error: "Enter the command to run, such as npx." };
  if (/\s|[;&|`$<>]/.test(command)) {
    return { ok: false, error: "The command is one program without arguments; put each argument on its own line." };
  }
  const args = rawArgs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const runner = RUNNERS[command.split("/").pop() ?? command];
  if (runner) {
    const spec = packageSpec(args);
    const exact = runner.label === "PyPI" ? PYPI_EXACT : NPM_EXACT;
    if (!spec || !exact.test(spec)) {
      return {
        ok: false,
        error: `Pin the ${runner.label} package to an exact version, for example ${runner.example}.`,
      };
    }
  }
  return { ok: true, value: { command, args } };
}

/**
 * A stdio definition pasted from another client's config: `{"mcpServers": {"name": {...}}}`, `{"name": {...}}`
 * or a bare `{"command", "args"}`. Environment values are refused rather than imported: they are usually
 * secrets, and a definition is not a vault.
 */
export function parseStdioImport(raw: string): Parsed<{ name?: string; command: string; args: string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Paste the server's JSON definition, as found in a client's MCP settings." };
  }
  if (!isRecord(value)) return { ok: false, error: "Paste one JSON object." };
  let name: string | undefined;
  let entry: Record<string, unknown> = value;
  if (!("command" in value) && !("url" in value)) {
    const servers = isRecord(value.mcpServers) ? value.mcpServers : isRecord(value.servers) ? value.servers : value;
    const names = Object.keys(servers);
    if (names.length !== 1) {
      return {
        ok: false,
        error: names.length
          ? `Paste one server at a time (found ${names.slice(0, 5).join(", ")}).`
          : "No server found in that JSON.",
      };
    }
    name = names[0];
    const only = name === undefined ? undefined : servers[name];
    if (!isRecord(only)) return { ok: false, error: "No server found in that JSON." };
    entry = only;
  }
  if (typeof entry.url === "string") {
    return { ok: false, error: "That is a remote server: add it by URL instead." };
  }
  if (isRecord(entry.env) && Object.keys(entry.env).length > 0) {
    return {
      ok: false,
      error: "Remove the env block: environment values are often secrets and are not imported into a definition.",
    };
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) {
    return { ok: false, error: "The definition has no command." };
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (!args.every((arg): arg is string => typeof arg === "string")) {
    return { ok: false, error: "Every argument must be a string." };
  }
  return { ok: true, value: { ...(name ? { name } : {}), command: entry.command.trim(), args } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The provider's redirect to `/auth/mcp/callback`, reduced to what the dashboard relays. Only `state`, `code` and
 * `iss` are kept, each shape-checked; a provider error becomes a fixed outcome and its text is never used.
 */
export type OAuthCallbackInput =
  | { kind: "complete"; state: string; code: string; issuer?: string }
  | { kind: "denied" }
  | { kind: "invalid" };

const OAUTH_STATE = /^[A-Za-z0-9._~-]{8,512}$/;
const OAUTH_CODE = /^[\x21-\x7e]{1,4096}$/;

export function oauthCallbackInput(params: URLSearchParams): OAuthCallbackInput {
  const error = params.get("error");
  if (error !== null) return error === "access_denied" ? { kind: "denied" } : { kind: "invalid" };
  const state = params.get("state");
  const code = params.get("code");
  if (!state || !OAUTH_STATE.test(state) || !code || !OAUTH_CODE.test(code)) return { kind: "invalid" };
  const iss = params.get("iss");
  if (iss === null) return { kind: "complete", state, code };
  const issuer = safeAuthorizationUrl(iss);
  if (!issuer || new URL(issuer).search || new URL(issuer).hash) return { kind: "invalid" };
  return { kind: "complete", state, code, issuer: iss };
}

/**
 * Where `/auth/mcp/callback` sends the browser: `/connections?oauth=<outcome>`, plus `connection=<id>` once the
 * server completed the sign-in. The page then asks the control API for that connection's actual status, so a
 * crafted link cannot make a connection look connected.
 */
export type OAuthReturn = { id: string | null; outcome: "returned" | "denied" | "failed" };

export function oauthReturn(params: Record<string, string | string[] | undefined>): OAuthReturn | null {
  const id = params.connection;
  const outcome = params.oauth;
  if (outcome === "denied" || outcome === "failed") {
    return { id: typeof id === "string" && UUID.test(id) ? id : null, outcome };
  }
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (outcome === undefined || typeof outcome === "string") return { id, outcome: "returned" };
  return null;
}

export function scopeLabel(scope: ConnectionScope): string {
  return scope === "personal" ? "Personal" : "Org";
}

export function authLabel(authType: ConnectionAuthType): string {
  switch (authType) {
    case "auto":
      return "Auto-detect";
    case "none":
      return "Public";
    case "bearer":
      return "Bearer token";
    case "headers":
      return "Custom headers";
    case "oauth":
      return "OAuth";
  }
}

export function transportLabel(transport: ConnectionTransport): string {
  return transport === "stdio" ? "stdio (in sandbox)" : transport === "sse" ? "SSE" : "Streamable HTTP";
}

/**
 * Who can see a sandbox, from its row (`sandboxes.visibility`, recorded at launch). Null for a row that predates
 * the column; the page then shows nothing rather than guessing.
 */
export function sandboxVisibility(row: object): SandboxVisibility | null {
  const value = (row as { visibility?: unknown }).visibility;
  return oneOf(SANDBOX_VISIBILITIES, value) ? value : null;
}
