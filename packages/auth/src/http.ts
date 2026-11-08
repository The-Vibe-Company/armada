import { assertHash, assertUuid } from "./codec.ts";
import { AuthError } from "./errors.ts";
import type { AuthFetch, AuthStore, ListedToken, Membership, TokenRecord, TokenTable } from "./types.ts";

interface HttpStoreOptions {
  fetch: AuthFetch;
  supabaseUrl: string;
  /** `apikey` header. The anon key for a user, the service role key for the server. */
  apiKey: string;
  /** Bearer credential: the user's access token, or the service role key. */
  authorization: string;
}

/**
 * PostgREST store. `createUserStore` sends the user's JWT, so RLS applies.
 * `createServiceStore` sends the service role key and is what token verification uses.
 */
export function createHttpAuthStore(options: HttpStoreOptions): AuthStore {
  const origin = stripSlash(options.supabaseUrl);
  const headers: Record<string, string> = {
    apikey: options.apiKey,
    authorization: `Bearer ${options.authorization}`,
    accept: "application/json",
  };

  async function call<T>(path: string, init: { method: string; body?: unknown } = { method: "GET" }): Promise<T> {
    const requestHeaders = { ...headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders.prefer = "return=representation";
      body = JSON.stringify(init.body);
    }
    let response: Response;
    try {
      response = await options.fetch(`${origin}/rest/v1/${path}`, {
        method: init.method,
        headers: requestHeaders,
        body,
      });
    } catch (error) {
      throw new AuthError("Armada could not reach Supabase.", "unavailable", error);
    }
    if (response.status === 409) throw new AuthError("That token is already registered.", "conflict");
    if (!response.ok) {
      const code = response.headers.get("sb-error-code");
      const answered = `Supabase answered ${response.status}${code ? ` (${code})` : ""} for ${init.method} ${path.split("?")[0]}`;
      throw new AuthError("Armada could not reach Supabase.", "unavailable", new Error(answered));
    }
    if (response.status === 204) return [] as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new AuthError("Armada could not reach Supabase.", "unavailable");
    }
  }

  async function membershipsOf(userId: string): Promise<Membership[]> {
    assertUuid(userId);
    const members = await call<Array<{ org_id: string; role: string }>>(
      `members?user_id=eq.${userId}&select=org_id,role`,
    );
    if (members.length === 0) return [];
    const ids = members.map((row) => row.org_id).filter((id) => assertUuidSafe(id));
    if (ids.length === 0) return [];
    const orgs = await call<Array<{ id: string; name: string }>>(`orgs?id=in.(${ids.join(",")})&select=id,name`);
    const names = new Map(orgs.map((org) => [org.id, org.name]));
    const result: Membership[] = [];
    for (const row of members) {
      const name = names.get(row.org_id);
      if (!name || (row.role !== "admin" && row.role !== "member")) continue;
      result.push({ orgId: row.org_id, name, role: row.role });
    }
    return result;
  }

  return {
    async findTokenByHash(kind, hash) {
      assertHash(hash);
      const rows = await call<TokenRow[]>(`${table(kind)}?hash=eq.${hash}&select=${TOKEN_COLUMNS}&limit=1`);
      return mapToken(rows[0]);
    },
    async insertToken(kind, input) {
      assertHash(input.hash);
      assertUuid(input.userId);
      assertUuid(input.orgId);
      const rows = await call<TokenRow[]>(`${table(kind)}?select=${TOKEN_COLUMNS}`, {
        method: "POST",
        body: {
          user_id: input.userId,
          org_id: input.orgId,
          hash: input.hash,
          label: input.label,
          created_at: input.createdAt,
        },
      });
      const row = mapToken(rows[0]);
      if (!row) throw new AuthError("Armada could not store the token.", "unavailable");
      return row;
    },
    async revokeToken(kind, input) {
      assertUuid(input.id);
      assertUuid(input.userId);
      const rows = await call<TokenRow[]>(
        `${table(kind)}?id=eq.${input.id}&user_id=eq.${input.userId}&revoked_at=is.null&select=${TOKEN_COLUMNS}`,
        { method: "PATCH", body: { revoked_at: input.revokedAt } },
      );
      return mapToken(rows[0]);
    },
    async revokeTokenByHash(kind, hash, revokedAt) {
      assertHash(hash);
      const rows = await call<Array<{ id: string }>>(`${table(kind)}?hash=eq.${hash}&revoked_at=is.null&select=id`, {
        method: "PATCH",
        body: { revoked_at: revokedAt },
      });
      return rows.length > 0;
    },
    async listServiceTokens(userId) {
      assertUuid(userId);
      const rows = await call<ListRow[]>(
        `service_tokens?user_id=eq.${userId}&select=id,label,created_at,revoked_at,orgs(name)&order=created_at.desc`,
      );
      const listed: ListedToken[] = [];
      for (const row of rows) {
        const name = row.orgs?.name;
        if (typeof name !== "string") continue;
        listed.push({
          id: row.id,
          label: row.label,
          orgName: name,
          createdAt: instant(row.created_at),
          revokedAt: row.revoked_at === null ? null : instant(row.revoked_at),
        });
      }
      return listed;
    },
    membership(userId, orgId) {
      return membershipsOf(userId).then((rows) => rows.find((row) => row.orgId === orgId) ?? null);
    },
    memberships: membershipsOf,
    async insertClient(input) {
      await call("oauth_clients", {
        method: "POST",
        body: { id: input.id, name: input.name, redirect_uris: input.redirectUris },
      });
    },
    async findClient(id) {
      if (!/^[0-9a-f]{32}$/.test(id)) return null;
      const rows = await call<Array<{ id: string; name: string; redirect_uris: string[] }>>(
        `oauth_clients?id=eq.${id}&select=id,name,redirect_uris&limit=1`,
      );
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, name: row.name, redirectUris: row.redirect_uris };
    },
    async findCode(hash, now) {
      assertHash(hash);
      const rows = await call<CodeRow[]>(
        `oauth_codes?hash=eq.${hash}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}&select=hash,client_id,redirect_uri,code_challenge,user_id,org_id,expires_at&limit=1`,
      );
      return mapCode(rows[0]);
    },
    async insertCode(input) {
      assertHash(input.hash);
      await call("oauth_codes", {
        method: "POST",
        body: {
          hash: input.hash,
          client_id: input.clientId,
          redirect_uri: input.redirectUri,
          code_challenge: input.codeChallenge,
          user_id: input.userId,
          org_id: input.orgId,
          expires_at: input.expiresAt,
          created_at: input.createdAt,
        },
      });
    },
    async consumeCode(hash, now) {
      assertHash(hash);
      const rows = await call<CodeRow[]>(
        `oauth_codes?hash=eq.${hash}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}&select=hash,client_id,redirect_uri,code_challenge,user_id,org_id,expires_at`,
        { method: "PATCH", body: { used_at: now } },
      );
      return mapCode(rows[0]);
    },
  };
}

/** The CLI's store: the anon key plus the signed-in user's access token. */
export function createUserStore(options: {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
}): AuthStore {
  return createHttpAuthStore({
    fetch: options.fetch,
    supabaseUrl: options.supabaseUrl,
    apiKey: options.anonKey,
    authorization: options.accessToken,
  });
}

/** The MCP server's store. Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. */
export function createServiceStore(options: { fetch?: AuthFetch; env?: NodeJS.ProcessEnv } = {}): AuthStore {
  const env = options.env ?? process.env;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new AuthError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", "usage");
  }
  return createHttpAuthStore({
    fetch: options.fetch ?? fetch,
    supabaseUrl,
    apiKey: serviceRoleKey,
    authorization: serviceRoleKey,
  });
}

/**
 * Every token read names its columns: a user JWT cannot select `hash`, so a bare insert (which
 * returns `*`) or `select=*` would be refused. Only the service role looks a token up by hash.
 */
const TOKEN_COLUMNS = "id,user_id,org_id,label,revoked_at,created_at";

function table(kind: TokenTable): string {
  return kind === "service" ? "service_tokens" : "mcp_tokens";
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function assertUuidSafe(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

interface TokenRow {
  id: string;
  user_id: string;
  org_id: string;
  label: string;
  revoked_at: string | null;
  created_at: string;
}

interface ListRow {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  orgs: { name: string } | null;
}

interface CodeRow {
  hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: string;
  org_id: string;
  expires_at: string;
}

function mapCode(row: CodeRow | undefined) {
  if (!row) return null;
  return {
    hash: row.hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    userId: row.user_id,
    orgId: row.org_id,
    expiresAt: instant(row.expires_at),
  };
}

function mapToken(row: TokenRow | undefined): TokenRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    label: row.label,
    revokedAt: row.revoked_at,
    createdAt: instant(row.created_at),
  };
}

function instant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AuthError("Armada could not reach Supabase.", "unavailable");
  return parsed.toISOString();
}
