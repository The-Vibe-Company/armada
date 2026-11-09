import type { CredentialKind, CredentialScope, MemberRole } from "./database.types.ts";
import type { GitHubConnectionStore, GitHubUser, StoredGitHubConnection } from "./github.ts";
import type { Sql } from "./golden-store.ts";
import type { CredentialInfo, MemberInfo, OrgSummary, VaultStore } from "./vault.ts";
import { VaultError } from "./vault-error.ts";

/**
 * The vault over SQL. The connection must be privileged: it reads ciphertext columns, and it reads
 * `auth.users` to find a person by email. Use the Supabase `postgres` role or `service_role`,
 * never a user JWT. Authorization is in `vault.ts`, not in this file.
 */
export function createSqlVaultStore(sql: Sql): VaultStore {
  return {
    async createOrg(name, adminUserId) {
      try {
        const result = await sql.query<{ id: string; name: string }>(
          `with created as (
             insert into public.orgs (name) values ($1) returning id, name
           ), admin as (
             insert into public.members (org_id, user_id, role)
             select id, $2, 'admin' from created
           )
           select id, name from created`,
          [name, adminUserId],
        );
        const row = result.rows[0];
        if (!row) throw new VaultError("unavailable", "The org could not be created.");
        return { id: row.id, name: row.name };
      } catch (error) {
        throw mapWriteError(error);
      }
    },

    async memberships(userId): Promise<OrgSummary[]> {
      const result = await sql.query<{ id: string; name: string; role: string }>(
        `select o.id, o.name, m.role::text as role
         from public.members m join public.orgs o on o.id = m.org_id
         where m.user_id = $1
         order by lower(o.name), o.id`,
        [userId],
      );
      return result.rows.map((row) => ({ id: row.id, name: row.name, role: role(row.role) }));
    },

    async findUserByEmail(email) {
      const result = await sql.query<{ id: string; email: string }>(
        `select id, email::text as email from auth.users where lower(email) = lower($1) limit 1`,
        [email],
      );
      return result.rows[0] ?? null;
    },

    async listMembers(orgId): Promise<MemberInfo[]> {
      const result = await sql.query<{
        user_id: string;
        email: string | null;
        role: string;
        created_at: string | Date;
      }>(
        `select m.user_id, u.email::text as email, m.role::text as role, m.created_at
         from public.members m left join auth.users u on u.id = m.user_id
         where m.org_id = $1
         order by m.created_at, u.email, m.user_id`,
        [orgId],
      );
      return result.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        role: role(row.role),
        createdAt: instant(row.created_at),
      }));
    },

    async addMember(orgId, userId, memberRole) {
      try {
        const result = await sql.query(
          `insert into public.members (org_id, user_id, role) values ($1, $2, $3::public.member_role)
           on conflict do nothing returning user_id`,
          [orgId, userId, memberRole],
        );
        return result.rows.length > 0;
      } catch (error) {
        throw mapWriteError(error);
      }
    },

    async setMemberRole(orgId, userId, memberRole) {
      try {
        const result = await sql.query(
          `update public.members set role = $3::public.member_role
           where org_id = $1 and user_id = $2 returning user_id`,
          [orgId, userId, memberRole],
        );
        return result.rows.length > 0;
      } catch (error) {
        throw mapWriteError(error);
      }
    },

    async removeMember(orgId, userId) {
      try {
        const result = await sql.query(
          `delete from public.members where org_id = $1 and user_id = $2 returning user_id`,
          [orgId, userId],
        );
        return result.rows.length > 0;
      } catch (error) {
        throw mapWriteError(error);
      }
    },

    async upsertCredential(scope, ownerId, kind, valueEnc) {
      await sql.query(
        `insert into public.credentials (scope, owner_id, kind, value_enc)
         values ($1::public.credential_scope, $2, $3::public.credential_kind, $4::bytea)
         on conflict (scope, owner_id, kind) do update set value_enc = excluded.value_enc`,
        [scope, ownerId, kind, valueEnc],
      );
    },

    async deleteCredential(scope, ownerId, kind) {
      const result = await sql.query(
        `delete from public.credentials
         where scope = $1::public.credential_scope and owner_id = $2 and kind = $3::public.credential_kind
         returning id`,
        [scope, ownerId, kind],
      );
      return result.rows.length > 0;
    },

    async listCredentials(scope, ownerId): Promise<CredentialInfo[]> {
      const result = await sql.query<{ kind: string; created_at: string | Date }>(
        `select kind::text as kind, created_at from public.credentials
         where scope = $1::public.credential_scope and owner_id = $2
         order by kind`,
        [scope, ownerId],
      );
      return result.rows.map((row) => ({ kind: row.kind as CredentialKind, createdAt: instant(row.created_at) }));
    },

    async setOrgBoatKey(orgId, valueEnc) {
      await sql.query(`update public.orgs set boat_api_key_enc = $2::bytea where id = $1`, [orgId, valueEnc]);
    },

    async hasOrgBoatKey(orgId) {
      const result = await sql.query<{ present: boolean }>(
        `select boat_api_key_enc is not null as present from public.orgs where id = $1`,
        [orgId],
      );
      return result.rows[0]?.present === true;
    },

    async credentials(scope: CredentialScope, ownerId: string) {
      const result = await sql.query<{ kind: string; value_enc: Uint8Array }>(
        `select kind::text as kind, value_enc from public.credentials
         where scope = $1::public.credential_scope and owner_id = $2`,
        [scope, ownerId],
      );
      return result.rows.map((row) => ({ kind: row.kind as CredentialKind, valueEnc: new Uint8Array(row.value_enc) }));
    },

    async getGitHubConnection(userId): Promise<StoredGitHubConnection | null> {
      return readGitHubConnection(sql, userId);
    },

    async withGitHubConnectionRefresh(userId, work) {
      if (!sql.transaction) return work(refreshStore(sql), await readGitHubConnection(sql, userId));
      return sql.transaction(async (transaction) => {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
        return work(refreshStore(transaction, true), await readGitHubConnection(transaction, userId));
      });
    },

    async rotateGitHubToken(userId, expected, next) {
      const result = await sql.query(
        `update public.github_connections
         set refresh_token_enc = $3::bytea, refresh_expires_at = $4::timestamptz,
           access_token_enc = $5::bytea, access_expires_at = $6::timestamptz, updated_at = now()
         where user_id = $1 and refresh_token_enc = $2::bytea and revoked_at is null
         returning user_id`,
        [
          userId,
          expected,
          next.refreshTokenEnc,
          next.refreshExpiresAt?.toISOString() ?? null,
          next.accessTokenEnc,
          next.accessExpiresAt.toISOString(),
        ],
      );
      return result.rows.length > 0;
    },

    async markGitHubRevoked(userId, expected) {
      const result = await sql.query(
        `update public.github_connections set revoked_at = now(), updated_at = now()
         where user_id = $1 and refresh_token_enc = $2::bytea and revoked_at is null
         returning user_id`,
        [userId, expected],
      );
      return result.rows.length > 0;
    },

    async updateGitHubProfile(userId, profile: GitHubUser) {
      await sql.query(
        `update public.github_connections set github_id = $2, login = $3, name = $4, updated_at = now()
         where user_id = $1`,
        [userId, profile.id, profile.login, profile.name],
      );
    },

    async orgBoatKey(orgId) {
      const result = await sql.query<{ key: Uint8Array | null }>(
        `select boat_api_key_enc as key from public.orgs where id = $1`,
        [orgId],
      );
      const key = result.rows[0]?.key;
      return key ? new Uint8Array(key) : null;
    },
  };
}

function role(value: string): MemberRole {
  if (value === "admin" || value === "member") return value;
  throw new VaultError("unavailable", "A membership has a role Armada does not know.");
}

function instant(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWriteError(error: unknown): Error {
  if (error instanceof VaultError) return error;
  const text = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const errno = typeof error === "object" && error !== null && "errno" in error ? String(error.errno) : "";
  if (text.includes("keeps at least one admin")) {
    return new VaultError("conflict", "An org keeps at least one admin.");
  }
  if (text.includes("orgs_name_key") || ((code === "23505" || errno === "23505") && text.includes("orgs"))) {
    return new VaultError("conflict", "An org with that name already exists.");
  }
  if (code === "23503" || errno === "23503") {
    return new VaultError("not_found", "No Armada account has that user id.");
  }
  return new VaultError("unavailable", "The database refused the change.");
}

type GitHubConnectionRow = {
  user_id: string;
  github_id: string | number;
  login: string;
  name: string | null;
  refresh_token_enc: Uint8Array;
  refresh_expires_at: string | Date | null;
  access_token_enc: Uint8Array | null;
  access_expires_at: string | Date | null;
  revoked_at: string | Date | null;
};

async function readGitHubConnection(sql: Sql, userId: string): Promise<StoredGitHubConnection | null> {
  const result = await sql.query<GitHubConnectionRow>(
    `select user_id, github_id, login, name, refresh_token_enc, refresh_expires_at,
      access_token_enc, access_expires_at, revoked_at
     from public.github_connections where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    githubId: Number(row.github_id),
    login: row.login,
    name: row.name,
    refreshTokenEnc: new Uint8Array(row.refresh_token_enc),
    refreshExpiresAt: row.refresh_expires_at === null ? null : new Date(row.refresh_expires_at),
    accessTokenEnc: row.access_token_enc === null ? null : new Uint8Array(row.access_token_enc),
    accessExpiresAt: row.access_expires_at === null ? null : new Date(row.access_expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

function refreshStore(sql: Sql, transactional = false): GitHubConnectionStore {
  return {
    getGitHubConnection: (userId) => readGitHubConnection(sql, userId),
    withGitHubConnectionRefresh: async () => {
      throw new Error("Nested GitHub refresh transactions are not supported.");
    },
    async rotateGitHubToken(userId, expected, next) {
      const result = await sql.query(
        `update public.github_connections
         set refresh_token_enc = $3::bytea, refresh_expires_at = $4::timestamptz,
           access_token_enc = $5::bytea, access_expires_at = $6::timestamptz, updated_at = now()
         where user_id = $1 and refresh_token_enc = $2::bytea and revoked_at is null
         returning user_id`,
        [
          userId,
          expected,
          next.refreshTokenEnc,
          next.refreshExpiresAt?.toISOString() ?? null,
          next.accessTokenEnc,
          next.accessExpiresAt.toISOString(),
        ],
      );
      return result.rows.length > 0;
    },
    async markGitHubRevoked(userId, expected) {
      const result = await sql.query(
        `update public.github_connections set revoked_at = now(), updated_at = now()
         where user_id = $1 and refresh_token_enc = $2::bytea and revoked_at is null
         returning user_id`,
        [userId, expected],
      );
      return result.rows.length > 0;
    },
    async updateGitHubProfile(userId, profile) {
      // Profile sync is best-effort, but an SQL error must not roll back a
      // refresh token GitHub has already consumed. Keep the advisory lock held.
      if (transactional) await sql.query("savepoint github_profile");
      try {
        await sql.query(
          `update public.github_connections set github_id = $2, login = $3, name = $4, updated_at = now()
           where user_id = $1`,
          [userId, profile.id, profile.login, profile.name],
        );
      } catch (error) {
        if (transactional) await sql.query("rollback to savepoint github_profile");
        throw error;
      } finally {
        if (transactional) await sql.query("release savepoint github_profile");
      }
    },
  };
}
