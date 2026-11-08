import { type AuthFetch, assertSupabaseUrl } from "@armada/auth";
import {
  addMember,
  createOrg,
  createSqlVaultStore,
  ENCRYPTION_KEY_ENV,
  EncryptionKeyError,
  listCredentials,
  listMembers,
  listOrgs,
  parseCredentialKind,
  parseRole,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveCredentials,
  resolveOrg,
  setCredential,
  setMemberRole,
  VaultError,
  type VaultErrorCode,
  type VaultStore,
} from "@armada/core";

export const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ControlOptions {
  /** Supabase project origin and anon key: they identify the project, so a user's session can be checked. */
  supabaseUrl: string;
  anonKey: string;
  /** Service-role access: orgs, members and ciphertext. See `createSqlVaultStore`. */
  store: VaultStore;
  /**
   * `ARMADA_ENCRYPTION_KEY`. Writes encrypt with it. `launch/resolve` also decrypts, and returns the
   * plaintext to the signed-in user's own machine, which is where the launch runs. Nothing is logged.
   */
  encryptionKey: string | undefined;
  fetch?: AuthFetch;
}

const STATUS: Record<VaultErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  missing_credential: 404,
  conflict: 409,
  unavailable: 503,
};

/**
 * The CLI's way to the things that need the server: org creation and email lookup (service role)
 * and credential encryption (the encryption key). Every call is a POST with the person's Supabase
 * access token as the bearer; the answer is JSON. Returns null for any other path, so #464 mounts
 * this next to the OAuth routes. No request body, token or credential value is logged.
 */
export async function handleControlRequest(request: Request, options: ControlOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX)) return null;
  const route = url.pathname.slice(CONTROL_PREFIX.length);
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const userId = await verifiedUser(request, options);
    const body = await readBody(request);
    const result = await dispatch(route, userId, body, options);
    if (result === undefined) return fail(404, "not_found", "Unknown route.");
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
    if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
    if (error instanceof EncryptionKeyError) {
      return fail(503, "unavailable", `Credential encryption is not configured on the server (${ENCRYPTION_KEY_ENV}).`);
    }
    return fail(500, "unavailable", "The server could not complete the request.");
  }
}

async function dispatch(
  route: string,
  userId: string,
  body: Record<string, unknown>,
  options: ControlOptions,
): Promise<unknown> {
  const { store, encryptionKey } = options;
  const org = optional(body, "org");
  switch (route) {
    case "org/create":
      return { org: await createOrg(store, userId, required(body, "name")) };
    case "org/list":
      return { orgs: await listOrgs(store, userId) };
    case "members/list":
      return listMembers(store, userId, org);
    case "members/add":
      return {
        member: await addMember(store, userId, {
          org,
          email: required(body, "email"),
          role: parseRole(optional(body, "role") ?? "member"),
        }),
      };
    case "members/role":
      await setMemberRole(store, userId, {
        org,
        email: required(body, "email"),
        role: parseRole(required(body, "role")),
      });
      return { ok: true };
    case "members/remove":
      await removeMember(store, userId, { org, email: required(body, "email") });
      return { ok: true };
    case "creds/set":
      await setCredential(store, encryptionKey, userId, {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
        value: required(body, "value"),
      });
      return { ok: true };
    case "creds/list":
      return listCredentials(store, userId, org);
    case "creds/rm":
      await removeCredential(store, userId, {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
      });
      return { ok: true };
    case "launch/resolve":
      return resolveLaunch(store, encryptionKey, userId, body, org);
    default:
      return undefined;
  }
}

async function resolveLaunch(
  store: VaultStore,
  encryptionKey: string | undefined,
  userId: string,
  body: Record<string, unknown>,
  orgRef: string | undefined,
): Promise<{ env: Record<string, string>; codexAuth: string | null; boatKey: string }> {
  const org = await resolveOrg(store, userId, orgRef);
  const harness = required(body, "harness");
  if (harness !== "claude" && harness !== "codex") throw new VaultError("invalid", "The agent is claude or codex.");
  const visibility = required(body, "visibility");
  if (visibility !== "org" && visibility !== "private")
    throw new VaultError("invalid", "Visibility is org or private.");
  const resolved = await resolveCredentials(store, encryptionKey, { userId, orgId: org.id, harness });
  const boat = await resolveBoatKey(store, encryptionKey, { userId, orgId: org.id, visibility });
  return { env: resolved.env, codexAuth: resolved.files[0]?.content ?? null, boatKey: boat.key };
}

class Unauthorized extends Error {}

async function verifiedUser(request: Request, options: ControlOptions): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new Unauthorized("Run armada login.");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${assertSupabaseUrl(options.supabaseUrl)}/auth/v1/user`, {
      headers: { apikey: options.anonKey, authorization: `Bearer ${match[1]}`, accept: "application/json" },
    });
  } catch {
    throw new VaultError("unavailable", "The server could not reach Supabase.");
  }
  if (response.status === 401 || response.status === 403) throw new Unauthorized("Run armada login.");
  if (!response.ok) throw new VaultError("unavailable", "The server could not check your session.");
  const user: unknown = await response.json().catch(() => null);
  const id = typeof user === "object" && user !== null && "id" in user ? user.id : undefined;
  if (typeof id !== "string" || !UUID.test(id)) throw new Unauthorized("Run armada login.");
  return id.toLowerCase();
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new VaultError("invalid", "The request is too large.");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError("invalid", "The request is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VaultError("invalid", "The request is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optional(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new VaultError("invalid", `${key} must be text.`);
  return value;
}

function required(body: Record<string, unknown>, key: string): string {
  const value = optional(body, key);
  if (value === undefined) throw new VaultError("invalid", `${key} is required.`);
  return value;
}

function scope(body: Record<string, unknown>): "user" | "org" {
  const value = required(body, "scope");
  if (value === "user" || value === "org") return value;
  throw new VaultError("invalid", "scope is user or org.");
}

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Wires the control API from the environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
 * `ARMADA_DATABASE_URL` (a privileged Postgres connection string, the Supabase `postgres` role)
 * and `ARMADA_ENCRYPTION_KEY`.
 */
export function controlOptionsFromEnv(env: Record<string, string | undefined>): ControlOptions {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}.`);
    return value;
  };
  const sql = new Bun.SQL(need("ARMADA_DATABASE_URL"));
  return {
    supabaseUrl: assertSupabaseUrl(need("SUPABASE_URL")),
    anonKey: need("SUPABASE_ANON_KEY"),
    encryptionKey: need(ENCRYPTION_KEY_ENV),
    store: createSqlVaultStore({
      async query<T>(text: string, params: unknown[] = []) {
        const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
        return { rows: Array.from(rows) };
      },
    }),
  };
}
