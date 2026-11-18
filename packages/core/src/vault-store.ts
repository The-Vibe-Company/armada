import { createHash } from "node:crypto";
import { accountModelCountsSql, accountWaitingCountSql, accountWorkingCountSql } from "./account-work-sql.ts";
import { type AgentDefault, connectionModels, HARNESS_KINDS, parseCredentialValue } from "./credentials.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import type { CredentialKind, CredentialScope, MemberRole } from "./database.types.ts";
import type { GitHubConnectionStore, GitHubUser, StoredGitHubConnection } from "./github.ts";
import type { Sql } from "./golden-store.ts";
import { harnessesForCredential, harnessForCredential, MODEL_CREDENTIAL_KINDS } from "./harnesses.ts";
import { MODEL_CATALOG } from "./models.ts";
import type { CredentialInfo, MemberInfo, OrgSummary, VaultStore } from "./vault.ts";
import { VaultError } from "./vault-error.ts";

// These SQL fragments contain only catalog-owned enum labels, never caller input.
const MODEL_KIND_SQL = MODEL_CREDENTIAL_KINDS.map((kind) => `'${kind}'`).join(",");
async function preserveMorphModels(previous: Uint8Array, replacement: Uint8Array, encryptionKey: string | undefined) {
  const apiKey = await decryptSecret(replacement, encryptionKey);
  if (apiKey.trimStart().startsWith("{")) return replacement;
  const raw = await decryptSecret(new Uint8Array(previous), encryptionKey);
  if (!raw.trimStart().startsWith("{")) return replacement;
  const models = connectionModels("morph", raw).map(({ model }) => model);
  if (!models.length) return replacement;
  const value = parseCredentialValue("morph", JSON.stringify({ apiKey, models }));
  return encryptSecret(value, encryptionKey);
}

function accountKinds(kind: CredentialKind): readonly CredentialKind[] {
  const harness = harnessForCredential(kind);
  if (!harness) throw new VaultError("invalid", "Not a model account.");
  return [
    ...new Set(
      Object.values(HARNESS_KINDS)
        .filter((kinds) => kinds.includes(kind))
        .flat(),
    ),
  ];
}
function defaultAccountMaxAgents(kind: CredentialKind): number | null {
  return kind === "morph" ? 2 : null;
}
const githubRefreshQueues = new WeakMap<Sql, Map<string, Promise<void>>>();

/**
 * The vault over SQL. The connection must be privileged: it reads ciphertext columns, and it reads
 * `auth.users` to find a person by email. Use the Supabase `postgres` role or `service_role`,
 * never a user JWT. Authorization is in `vault.ts`, not in this file.
 */
export function createSqlVaultStore(sql: Sql): VaultStore {
  return {
    async agentDefaults(userId) {
      return (
        await sql.query<AgentDefault>(
          `select harness, credential_id as "credentialId", model from public.agent_defaults where user_id=$1`,
          [userId],
        )
      ).rows;
    },
    async setAgentDefault(userId, value, orgId) {
      if (!sql.transaction) throw new VaultError("unavailable", "Agent defaults require a transaction.");
      await sql.transaction(async (tx) => {
        if (value.credentialId) {
          const account = await tx.query<{ kind: CredentialKind }>(
            `select c.kind from public.credentials c where c.id=$1 and c.status<>'deleted' and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and ($3::uuid is null or c.owner_id=$3) and exists(select 1 from public.members m where m.org_id=c.owner_id and m.user_id=$2))) for share`,
            [value.credentialId, userId, orgId ?? null],
          );
          if (!account.rows[0] || !HARNESS_KINDS[value.harness].includes(account.rows[0].kind))
            throw new VaultError("not_found", "No compatible visible account.");
        }
        await tx.query(
          `insert into public.agent_defaults(user_id,harness,credential_id,model) values($1,$2,$3,$4) on conflict(user_id,harness) do update set credential_id=excluded.credential_id,model=excluded.model`,
          [userId, value.harness, value.credentialId, value.model],
        );
      });
    },
    async mutateAccount(userId, input, valueEnc, encryptionKey) {
      if (!sql.transaction) throw new VaultError("unavailable", "Account mutations require a transaction.");
      return sql.transaction(async (tx) => {
        const owner = input.scope === "user" ? userId : input.org;
        // Serialize defaults and mutations per owner; authorization is checked after taking the lock.
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
        if (input.scope === "org") {
          const admin = await tx.query(
            "select 1 from public.members where org_id=$1 and user_id=$2 and role='admin' for share",
            [owner, userId],
          );
          if (!admin.rows.length) throw new VaultError("forbidden", "Only an org admin can do that.");
        }
        const existing = input.id
          ? await tx.query<{ kind: CredentialKind; version: number; value_enc: Uint8Array }>(
              `select kind, version, value_enc from public.credentials where id=$1 and scope=$2::public.credential_scope and owner_id=$3 and kind in (${MODEL_KIND_SQL}) and status <> 'deleted' for update`,
              [input.id, input.scope, owner],
            )
          : { rows: [] };
        if (input.id && !existing.rows.length) throw new VaultError("not_found", "No such account.");
        const kind = existing.rows[0]?.kind ?? input.kind;
        if (!kind || !MODEL_CREDENTIAL_KINDS.some((value) => value === kind))
          throw new VaultError("invalid", "Named accounts require a model credential.");
        if (input.kind && existing.rows[0] && input.kind !== kind)
          throw new VaultError("invalid", "An account kind cannot change.");
        if (input.action !== "set" && !input.id) throw new VaultError("invalid", "Account id is required.");
        let id = input.id;
        if (input.action === "set" && input.id && existing.rows[0]?.version !== input.expectedVersion)
          throw new VaultError("conflict", "The account revision changed. Restart login; no secret was overwritten.");
        const previous = existing.rows[0]?.value_enc;
        const sealed =
          kind === "morph" && previous && valueEnc
            ? await preserveMorphModels(previous, valueEnc, encryptionKey)
            : valueEnc;
        if (input.action === "set") {
          if (id)
            await tx.query(
              "update public.credentials set value_enc=$2::bytea, status='active', expires_at=$3::timestamptz where id=$1",
              [id, sealed, input.expiresAt ?? null],
            );
          else {
            const created = await tx.query<{ id: string }>(
              "insert into public.credentials(scope,owner_id,kind,value_enc,name,expires_at,max_agents) values($1::public.credential_scope,$2,$3::public.credential_kind,$4::bytea,$5,$6::timestamptz,$7) returning id",
              [
                input.scope,
                owner,
                kind,
                sealed,
                input.name?.trim() ?? "Default",
                input.expiresAt ?? null,
                input.model === undefined && input.maxAgents !== undefined
                  ? input.maxAgents
                  : defaultAccountMaxAgents(kind),
              ],
            );
            id = created.rows[0]?.id;
          }
        }
        if (input.model !== undefined) {
          let models: readonly string[] = harnessesForCredential(kind).flatMap((harness) =>
            MODEL_CATALOG[harness].models.map((model) => model.id),
          );
          const encrypted = existing.rows[0]?.value_enc;
          const morphValue = kind === "morph" ? (input.action === "set" ? sealed : encrypted) : undefined;
          if (morphValue) {
            const raw = await decryptSecret(new Uint8Array(morphValue), encryptionKey);
            models = connectionModels(kind, raw).flatMap(({ model }) => [model, `armada/${model}`]);
          }
          if (encrypted && (kind === "openai" || kind === "anthropic" || kind === "opencode")) {
            const raw = await decryptSecret(new Uint8Array(encrypted), encryptionKey);
            if (raw.startsWith("{")) {
              const connection = JSON.parse(raw);
              if (kind === "opencode") models = connection.endpoint.models.map((model: string) => `armada/${model}`);
              else if (Array.isArray(connection.models)) models = connection.models;
              // Uncatalogued gateways accept any well-formed identifier, as launch does.
              else if (connection.endpoint)
                models = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/.test(input.model) ? [input.model] : [];
            } else if (kind === "opencode") {
              models = /^(opencode|opencode-go)\/[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/.test(input.model)
                ? [input.model]
                : [];
            }
          }
          if (!models.includes(input.model) && !(kind === "morph" && input.maxAgents === null))
            throw new VaultError("invalid", `Account cannot serve model ${input.model}.`);
          await tx.query(
            "update public.credentials set model_limits=case when $3::integer is null then model_limits-$2::text else jsonb_set(model_limits,array[$2::text],to_jsonb($3::integer)) end where id=$1",
            [id, input.model, input.maxAgents],
          );
        }
        if (input.model === undefined && input.maxAgents !== undefined)
          await tx.query("update public.credentials set max_agents=$2 where id=$1", [id, input.maxAgents]);
        if (input.action === "limits" || input.action === "set") {
          // Limits do not rotate secrets or change defaults.
        } else if (input.action === "rename") {
          if (!input.name) throw new VaultError("invalid", "Name is required.");
          await tx.query("update public.credentials set name=$2 where id=$1", [id, input.name.trim()]);
        } else if (input.action === "remove") {
          await tx.query("update public.credentials set status='deleted' where id=$1", [id]);
        } else {
          await tx.query(
            `update public.credentials set is_default=false where scope=$1::public.credential_scope and owner_id=$2 and kind::text in (select jsonb_array_elements_text($3::jsonb)) and kind in (${MODEL_KIND_SQL})`,
            [input.scope, owner, JSON.stringify(accountKinds(kind))],
          );
          await tx.query("update public.credentials set is_default=true where id=$1", [id]);
        }
        const rows = await createSqlVaultStore(tx).listCredentials(input.scope, owner ?? "");
        const row = rows.find((row) => row.id === id);
        if (!row)
          throw new VaultError(
            "unavailable",
            "The account change could not be verified because the updated account was not returned. Reload the account list before retrying.",
          );
        return row;
      });
    },
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

    async upsertCredential(scope, ownerId, kind, valueEnc, actorId, encryptionKey) {
      if (kind !== "boat" && kind !== "modal" && kind !== "skillpack") {
        if (!sql.transaction) throw new VaultError("unavailable", "Credential writes require a transaction.");
        await sql.transaction(async (tx) => {
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
          // A public legacy write carries its authenticated actor. Lock current org
          // authority in this same mutation transaction, including after slow admission checks.
          if (actorId !== undefined) {
            if (scope === "user" && ownerId !== actorId)
              throw new VaultError("forbidden", "Only the account owner can do that.");
            if (scope === "org") {
              const admin = await tx.query(
                "select 1 from public.members where org_id=$1 and user_id=$2 and role='admin' for share",
                [ownerId, actorId],
              );
              if (!admin.rows.length) throw new VaultError("forbidden", "Only an org admin can do that.");
            }
          }
          const found = await tx.query<{ id: string; value_enc: Uint8Array }>(
            "select id, value_enc from public.credentials where scope=$1::public.credential_scope and owner_id=$2 and kind=$3::public.credential_kind and status <> 'deleted' for update",
            [scope, ownerId, kind],
          );
          if (found.rows.length > 1) throw new VaultError("conflict", "Multiple accounts: specify an account id.");
          const ambiguous = await tx.query(
            `select kind from public.credentials where scope=$1::public.credential_scope and owner_id=$2 and status <> 'deleted' and kind in (${MODEL_KIND_SQL}) and kind::text in (select jsonb_array_elements_text($3::jsonb)) group by kind having count(*) > 1`,
            [scope, ownerId, JSON.stringify(accountKinds(kind))],
          );
          if (ambiguous.rows.length) throw new VaultError("conflict", "Multiple accounts: specify an account id.");
          const existing = found.rows[0];
          if (existing) {
            const sealed =
              kind === "morph" && actorId !== undefined
                ? await preserveMorphModels(existing.value_enc, valueEnc, encryptionKey)
                : valueEnc;
            await tx.query("update public.credentials set value_enc=$2::bytea,status='active' where id=$1", [
              existing.id,
              sealed,
            ]);
          } else
            await tx.query(
              "insert into public.credentials(scope,owner_id,kind,value_enc,max_agents) values($1::public.credential_scope,$2,$3::public.credential_kind,$4::bytea,$5)",
              [scope, ownerId, kind, valueEnc, defaultAccountMaxAgents(kind)],
            );
          // Legacy kind writes preserve the old harness preference through explicit defaults.
          const preferred = await tx.query<{ id: string }>(
            `select id from public.credentials where scope=$1::public.credential_scope and owner_id=$2 and status='active' and name='Default' and kind::text in (select jsonb_array_elements_text($3::jsonb)) and kind in (${MODEL_KIND_SQL}) order by case when kind in ('claude_oauth','openai') then 0 else 1 end limit 1`,
            [scope, ownerId, JSON.stringify(accountKinds(kind))],
          );
          const named = await tx.query(
            `select 1 from public.credentials where scope=$1::public.credential_scope and owner_id=$2 and name <> 'Default' and kind in (${MODEL_KIND_SQL})`,
            [scope, ownerId],
          );
          if (preferred.rows[0] && !named.rows.length) {
            await tx.query(
              `update public.credentials set is_default=false where scope=$1::public.credential_scope and owner_id=$2 and kind::text in (select jsonb_array_elements_text($3::jsonb)) and kind in (${MODEL_KIND_SQL})`,
              [scope, ownerId, JSON.stringify(accountKinds(kind))],
            );
            await tx.query("update public.credentials set is_default=true where id=$1", [preferred.rows[0].id]);
          }
        });
        return;
      }
      await sql.query(
        `insert into public.credentials(scope,owner_id,kind,value_enc) values($1::public.credential_scope,$2,$3::public.credential_kind,$4::bytea) on conflict(scope,owner_id,kind) where kind not in (${MODEL_KIND_SQL}) do update set value_enc=excluded.value_enc`,
        [scope, ownerId, kind, valueEnc],
      );
    },

    async deleteCredential(scope, ownerId, kind) {
      if (!sql.transaction) throw new VaultError("unavailable", "Credential removal requires a transaction.");
      return sql.transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
        const rows = (await createSqlVaultStore(tx).listCredentials(scope, ownerId)).filter(
          (row) => row.kind === kind && row.status !== "deleted",
        );
        if (rows.length > 1) throw new VaultError("conflict", "Multiple accounts: specify an account id.");
        if (!rows[0]) return false;
        await tx.query(
          kind === "boat" || kind === "modal" || kind === "skillpack"
            ? "delete from public.credentials where id=$1"
            : "update public.credentials set status='deleted' where id=$1",
          [rows[0].id],
        );
        return true;
      });
    },

    async listCredentials(scope, ownerId): Promise<CredentialInfo[]> {
      const result = await sql.query<{
        id: string;
        name: string;
        max_agents: number | null;
        model_limits: Record<string, number>;
        model_counts: Record<string, { runningAgents: number; waitingAgents: number }>;
        running_agents: string;
        waiting_agents: string;
        is_default: boolean;
        status: string;
        expires_at: string | null;
        updated_at: string;
        version: number;
        kind: string;
        created_at: string | Date;
      }>(
        `select id,name,max_agents,model_limits,${accountModelCountsSql("credentials.id", "credentials.model_limits")} as model_counts,${accountWorkingCountSql("credentials.id")} as running_agents,${accountWaitingCountSql("credentials.id", "credentials.max_agents")} as waiting_agents,is_default,status,expires_at,updated_at,version,kind::text as kind, created_at from public.credentials
         where scope = $1::public.credential_scope and owner_id = $2
         order by kind`,
        [scope, ownerId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        maxAgents: row.max_agents,
        modelLimits: row.model_limits ?? {},
        modelCounts: row.model_counts ?? {},
        runningAgents: Number(row.running_agents ?? 0),
        waitingAgents: Number(row.waiting_agents ?? 0),
        isDefault: row.is_default,
        status: row.status,
        expiresAt: row.expires_at ? instant(row.expires_at) : null,
        updatedAt: instant(row.updated_at),
        version: row.version,
        kind: row.kind as CredentialKind,
        createdAt: instant(row.created_at),
      }));
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
      const result = await sql.query<{
        id: string;
        is_default: boolean;
        status: string;
        expires_at: string | null;
        version: number;
        kind: string;
        value_enc: Uint8Array;
      }>(
        `select id,is_default,status,expires_at,version,kind::text as kind, value_enc from public.credentials
         where scope = $1::public.credential_scope and owner_id = $2`,
        [scope, ownerId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        isDefault: row.is_default,
        status: row.status,
        expiresAt: row.expires_at,
        version: row.version,
        kind: row.kind as CredentialKind,
        valueEnc: new Uint8Array(row.value_enc),
      }));
    },

    async getGitHubConnection(userId): Promise<StoredGitHubConnection | null> {
      return readGitHubConnection(sql, userId);
    },

    consumeGitHubRefresh: (userId, expected) => consumeGitHubRefresh(sql, userId, expected),

    async withGitHubConnectionRefresh(userId, work) {
      // Queue local callers without reserving a database connection during HTTP.
      // Across processes the durable consumed-token fence prevents replay.
      let queues = githubRefreshQueues.get(sql);
      if (!queues) {
        queues = new Map();
        githubRefreshQueues.set(sql, queues);
      }
      const previous = queues.get(userId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(userId, current);
      await previous;
      try {
        const connection = await readGitHubConnection(sql, userId);
        return await work(refreshStore(sql, connection?.refreshTokenEnc), connection);
      } finally {
        release();
        if (queues.get(userId) === current) queues.delete(userId);
      }
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
  connection_epoch: string;
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
      access_token_enc, access_expires_at, revoked_at, connection_epoch
     from public.github_connections where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    githubId: Number(row.github_id),
    connectionEpoch: row.connection_epoch,
    login: row.login,
    name: row.name,
    refreshTokenEnc: new Uint8Array(row.refresh_token_enc),
    refreshExpiresAt: row.refresh_expires_at === null ? null : new Date(row.refresh_expires_at),
    accessTokenEnc: row.access_token_enc === null ? null : new Uint8Array(row.access_token_enc),
    accessExpiresAt: row.access_expires_at === null ? null : new Date(row.access_expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

function refreshStore(sql: Sql, expectedRefresh: Uint8Array | undefined): GitHubConnectionStore {
  return {
    consumeGitHubRefresh: (userId, expected) => consumeGitHubRefresh(sql, userId, expected),
    getGitHubConnection: (userId) => readGitHubConnection(sql, userId),
    withGitHubConnectionRefresh: async () => {
      throw new Error("Nested GitHub refresh scopes are not supported.");
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
      if (result.rows.length) expectedRefresh = next.refreshTokenEnc;
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
      // A reconnect may publish during HTTP. Never overwrite its newer identity.
      await sql.query(
        `update public.github_connections set github_id = $2, login = $3, name = $4, updated_at = now()
         where user_id = $1 and refresh_token_enc = $5::bytea and revoked_at is null`,
        [userId, profile.id, profile.login, profile.name, expectedRefresh],
      );
    },
  };
}

/** Autocommit before remote HTTP. If HTTP or rotation publication is uncertain,
 * this row survives to forbid replay even when another process reads the old token. */
async function consumeGitHubRefresh(sql: Sql, userId: string, expected: Uint8Array): Promise<boolean> {
  const hash = createHash("sha256").update(expected).digest("hex");
  const result = await (sql.autonomousQuery ?? sql.query).call(
    sql,
    `insert into public.github_refresh_fences(user_id,refresh_hash)
 select user_id,$3 from public.github_connections where user_id=$1::uuid and refresh_token_enc=$2::bytea and revoked_at is null
 on conflict do nothing returning user_id`,
    [userId, expected, hash],
  );
  return result.rows.length === 1;
}
