import { assertHash } from "./codec.ts";
import { AuthError } from "./errors.ts";
import type { AuthStore, Membership, OAuthCodeRecord, TokenRecord, TokenTable } from "./types.ts";

export interface SqlQuery {
  query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** Service-role SQL. The API-only CLI calls the server, never the database directly. */
export function createSqlAuthStore(db: SqlQuery): AuthStore {
  return {
    async findTokenByHash(kind, hash) {
      assertHash(hash);
      const result = await db.query<TokenRow>(
        `select id, user_id, org_id, label, revoked_at, created_at
         from ${table(kind)} where hash = $1`,
        [hash],
      );
      return mapToken(result.rows[0]);
    },
    async insertToken(kind, input) {
      assertHash(input.hash);
      const result = await db.query<TokenRow>(
        `insert into ${table(kind)} (user_id, org_id, hash, label, created_at)
         values ($1, $2, $3, $4, $5::timestamptz)
         returning id, user_id, org_id, label, revoked_at, created_at`,
        [input.userId, input.orgId, input.hash, input.label, input.createdAt],
      );
      const row = mapToken(result.rows[0]);
      if (!row) throw new AuthError("Armada could not store the token.", "unavailable");
      return row;
    },
    async revokeToken(kind, input) {
      const result = await db.query<TokenRow>(
        `update ${table(kind)} set revoked_at = $3::timestamptz
         where id = $1 and user_id = $2 and revoked_at is null
         returning id, user_id, org_id, label, revoked_at, created_at`,
        [input.id, input.userId, input.revokedAt],
      );
      return mapToken(result.rows[0]);
    },
    async revokeTokenByHash(kind, hash, revokedAt) {
      assertHash(hash);
      const result = await db.query<{ id: string }>(
        `update ${table(kind)} set revoked_at = $2::timestamptz
         where hash = $1 and revoked_at is null
         returning id`,
        [hash, revokedAt],
      );
      return result.rows.length > 0;
    },
    async listServiceTokens(userId) {
      const result = await db.query<ListRow>(
        `select t.id, t.label, t.created_at, t.revoked_at, o.name as org_name
         from public.service_tokens t
         join public.orgs o on o.id = t.org_id
         where t.user_id = $1
         order by t.created_at desc, t.id`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: text(row.id),
        label: text(row.label),
        orgName: text(row.org_name),
        createdAt: instant(row.created_at),
        revokedAt: row.revoked_at === null ? null : instant(row.revoked_at),
      }));
    },
    async membership(userId, orgId) {
      const result = await db.query<MemberRow>(
        `select m.org_id, m.role, o.name
         from public.members m
         join public.orgs o on o.id = m.org_id
         where m.user_id = $1 and m.org_id = $2`,
        [userId, orgId],
      );
      return mapMember(result.rows[0]);
    },
    async memberships(userId) {
      const result = await db.query<MemberRow>(
        `select m.org_id, m.role, o.name
         from public.members m
         join public.orgs o on o.id = m.org_id
         where m.user_id = $1
         order by o.name, m.org_id`,
        [userId],
      );
      return result.rows.flatMap((row) => {
        const member = mapMember(row);
        return member ? [member] : [];
      });
    },
    async insertClient(input) {
      await db.query(`insert into public.oauth_clients (id, name, redirect_uris) values ($1, $2, $3::text[])`, [
        input.id,
        input.name,
        input.redirectUris,
      ]);
    },
    async findClient(id) {
      const result = await db.query<{ id: string; name: string; redirect_uris: unknown }>(
        `select id, name, redirect_uris from public.oauth_clients where id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { id: text(row.id), name: text(row.name), redirectUris: texts(row.redirect_uris) };
    },
    async findCode(hash, now) {
      assertHash(hash);
      const result = await db.query<CodeRow>(
        `select hash, client_id, redirect_uri, code_challenge, user_id, org_id, expires_at
         from public.oauth_codes
         where hash = $1 and used_at is null and expires_at > $2::timestamptz`,
        [hash, now],
      );
      return mapCode(result.rows[0]);
    },
    async insertCode(input) {
      assertHash(input.hash);
      await db.query(
        `insert into public.oauth_codes
           (hash, client_id, redirect_uri, code_challenge, user_id, org_id, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [
          input.hash,
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          input.userId,
          input.orgId,
          input.expiresAt,
          input.createdAt,
        ],
      );
    },
    async consumeCode(hash, now) {
      assertHash(hash);
      const result = await db.query<CodeRow>(
        `update public.oauth_codes set used_at = $2::timestamptz
         where hash = $1 and used_at is null and expires_at > $2::timestamptz
         returning hash, client_id, redirect_uri, code_challenge, user_id, org_id, expires_at`,
        [hash, now],
      );
      return mapCode(result.rows[0]);
    },
  };
}

function table(kind: TokenTable): string {
  return kind === "service" ? "public.service_tokens" : "public.mcp_tokens";
}

interface TokenRow extends Record<string, unknown> {
  id: unknown;
  user_id: unknown;
  org_id: unknown;
  label: unknown;
  revoked_at: unknown;
  created_at: unknown;
}

interface ListRow extends Record<string, unknown> {
  id: unknown;
  label: unknown;
  created_at: unknown;
  revoked_at: unknown;
  org_name: unknown;
}

interface MemberRow extends Record<string, unknown> {
  org_id: unknown;
  role: unknown;
  name: unknown;
}

interface CodeRow extends Record<string, unknown> {
  hash: unknown;
  client_id: unknown;
  redirect_uri: unknown;
  code_challenge: unknown;
  user_id: unknown;
  org_id: unknown;
  expires_at: unknown;
}

function mapToken(row: TokenRow | undefined): TokenRecord | null {
  if (!row) return null;
  return {
    id: text(row.id),
    userId: text(row.user_id),
    orgId: text(row.org_id),
    label: text(row.label),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : instant(row.revoked_at),
    createdAt: instant(row.created_at),
  };
}

function mapMember(row: MemberRow | undefined): Membership | null {
  if (!row) return null;
  const role = text(row.role);
  if (role !== "admin" && role !== "member") return null;
  return { orgId: text(row.org_id), name: text(row.name), role };
}

function mapCode(row: CodeRow | undefined): OAuthCodeRecord | null {
  if (!row) return null;
  return {
    hash: text(row.hash),
    clientId: text(row.client_id),
    redirectUri: text(row.redirect_uri),
    codeChallenge: text(row.code_challenge),
    userId: text(row.user_id),
    orgId: text(row.org_id),
    expiresAt: instant(row.expires_at),
  };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  throw new AuthError("Armada could not read the database.", "unavailable");
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new AuthError("Armada could not read the database.", "unavailable");
}

function texts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item));
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const body = value.slice(1, -1);
    return body.length === 0 ? [] : body.split(",");
  }
  throw new AuthError("Armada could not read the database.", "unavailable");
}
