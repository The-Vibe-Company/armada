// The Armada API the CLI calls, under /api/cli: signing in from a terminal
// (Better Auth's device authorization), who is signed in, and signing out.
// A terminal holds either a session token from `armada login` (sent as
// `Authorization: Bearer`) or an organization API key (`x-api-key`); it never
// holds the browser's cookie. Both proxy gates let /api/cli through: each
// route checks its own credential, and while the deployment has no accounts
// every route refuses with the next step instead of a password prompt.
// Everything is injected so tests run it on a local database.
import type { Client } from "@libsql/client";
import { type Auth, organizationOf } from "./accounts";
import { AUTH_API_PREFIX, type AuthSettings, CLI_CLIENT_ID } from "./accounts-settings";

export interface CliAccounts {
  auth: Auth;
  client: Client;
  settings: AuthSettings;
}

export interface CliApiDeps {
  /** The deployment's accounts; null while it runs on the shared password. Throws when they cannot be opened. */
  accounts: () => Promise<CliAccounts | null>;
  now?: () => Date;
}

/** Who a terminal is signed in as. Carries no secret. */
export interface CliIdentity {
  schemaVersion: 1;
  via: "session" | "api-key";
  /** The person, for a session; null for an API key, which acts for its organization. */
  user: { id: string; name: string; email: string } | null;
  /** The organization the terminal acts for; null when a person belongs to none yet. */
  organization: { id: string; name: string; slug: string; role: string | null } | null;
  /** The key's name and first characters, for an API key. */
  apiKey: { id: string; name: string | null; start: string | null } | null;
  expiresAt: string | null;
}

const NO_STORE = { "Cache-Control": "no-store" };
const LOGIN = "armada login";

const refuse = (status: number, error: string, next: string) =>
  Response.json({ error, next }, { status, headers: NO_STORE });

const signedOut = (error: string) => refuse(401, error, LOGIN);

/** Session lifetime and refresh age, as `createAuth` sets them. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_SECONDS = 24 * 60 * 60;

type Credential = { kind: "session"; token: string } | { kind: "api-key"; key: string } | null;

function credentialOf(request: Request): Credential {
  const key = request.headers.get("x-api-key")?.trim();
  if (key) return { kind: "api-key", key };
  const header = request.headers.get("authorization") ?? "";
  const token = /^bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  return token ? { kind: "session", token } : null;
}

const dateOf = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The session behind a CLI token, refreshed like a browser's: past a day of
 * use it lasts another 30 days. Null when unknown or expired.
 */
async function sessionOf(a: CliAccounts, token: string, now: Date) {
  const ctx = await a.auth.$context;
  const found = await ctx.internalAdapter.findSession(token);
  const expiresAt = dateOf(found?.session.expiresAt);
  if (!found || !expiresAt || expiresAt <= now) return null;
  let expires = expiresAt;
  if (expiresAt.getTime() - (SESSION_SECONDS - REFRESH_SECONDS) * 1000 <= now.getTime()) {
    expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
    await ctx.internalAdapter.updateSession(token, { expiresAt: expires, updatedAt: now });
  }
  return { ...found, expiresAt: expires };
}

async function organizationById(client: Client, id: string) {
  const rs = await client.execute({
    sql: `SELECT "id", "name", "slug" FROM "organization" WHERE "id" = ?`,
    args: [id],
  });
  const row = rs.rows[0];
  return row ? { id: String(row.id), name: String(row.name), slug: String(row.slug), role: null } : null;
}

async function identify(a: CliAccounts, credential: Credential, now: Date): Promise<CliIdentity | Response> {
  if (!credential) return signedOut("not signed in to Armada");
  if (credential.kind === "api-key") {
    const result = await a.auth.api.verifyApiKey({ body: { key: credential.key } });
    const key = result.valid ? result.key : null;
    const organization = key ? await organizationById(a.client, key.referenceId) : null;
    if (!key || !organization) return signedOut("this Armada API key is not valid: it was revoked, or never existed");
    return {
      schemaVersion: 1,
      via: "api-key",
      user: null,
      organization,
      apiKey: { id: key.id, name: key.name ?? null, start: key.start ?? null },
      expiresAt: dateOf(key.expiresAt)?.toISOString() ?? null,
    };
  }
  const found = await sessionOf(a, credential.token, now);
  if (!found) return signedOut("the Armada sign-in of this terminal has expired or was revoked");
  const active = (found.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  return {
    schemaVersion: 1,
    via: "session",
    user: { id: found.user.id, name: found.user.name, email: found.user.email },
    organization: await organizationOf(a.client, found.user.id, active),
    apiKey: null,
    expiresAt: found.expiresAt.toISOString(),
  };
}

/**
 * Hands a device-authorization call to Better Auth's own route, so its checks
 * and rate limit apply, with the CLI's client id. Cookies never go back: the
 * terminal keeps the token from the body.
 */
async function forward(
  a: CliAccounts,
  request: Request,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["user-agent", "x-forwarded-for", "x-real-ip"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const res = await a.auth.handler(
    new Request(new URL(`${AUTH_API_PREFIX}${path}`, a.settings.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, client_id: CLI_CLIENT_ID }),
    }),
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...NO_STORE },
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Answers one request under /api/cli; `path` is what follows the prefix, e.g. ["session"]. */
export async function handleCli(request: Request, path: string[], deps: CliApiDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  let a: CliAccounts | null;
  try {
    a = await deps.accounts();
  } catch (err) {
    console.error(`armada dashboard: sign-in unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(503, "Armada cannot check sign-ins right now", "the same command again in a moment");
  }
  if (!a)
    return refuse(
      503,
      "this Armada has no accounts yet (it runs on the shared dashboard password), so a terminal cannot sign in to it",
      "ask its owner to set up accounts (the ARMADA_AUTH_* variables); until then, keep the keys in `armada auth login`",
    );

  const route = `${request.method} ${path.join("/")}`;
  if (route === "POST device/code") return forward(a, request, "/device/code", {});
  if (route === "POST device/token") {
    const code = (await jsonBody(request)).device_code;
    if (typeof code !== "string" || !code)
      return Response.json({ error: "invalid_request", error_description: "device_code is required" }, { status: 400 });
    return forward(a, request, "/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code,
    });
  }
  if (route === "GET session") {
    const identity = await identify(a, credentialOf(request), now);
    return identity instanceof Response ? identity : Response.json(identity, { headers: NO_STORE });
  }
  if (route === "DELETE session") {
    const credential = credentialOf(request);
    if (credential?.kind === "api-key")
      return refuse(400, "an API key is not signed out: it is revoked in the app", "the Organization page of Armada");
    // Idempotent: an unknown or already revoked token is signed out all the same.
    if (credential) await (await a.auth.$context).internalAdapter.deleteSession(credential.token);
    return Response.json({ signedOut: true }, { headers: NO_STORE });
  }
  return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
