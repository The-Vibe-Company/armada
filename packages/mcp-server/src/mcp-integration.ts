import { createSqlMcpPendingOAuthPort, decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { OAuthStore, SecretBox, StoredGrant } from "../../mcp-gateway/src/index.ts";

/** The existing vault envelope, represented as base64 only inside the broker boundary. */
export function createMcpSecretBox(key: string | undefined): SecretBox {
  return {
    seal: async (plaintext) => Buffer.from(await encryptSecret(plaintext, key)).toString("base64"),
    open: async (ciphertext) => decryptSecret(new Uint8Array(Buffer.from(ciphertext, "base64")), key),
  };
}

/** Privileged SQL adapter: initial CAS, exclusive consumed refresh fence, and actor-bound pending state. */
export function createMcpOAuthStore(
  sql: Sql,
  key: string | undefined,
  callbackActorId?: string,
  publicationSignal?: AbortSignal,
): OAuthStore {
  const pending = createSqlMcpPendingOAuthPort(sql, key);
  // One actor-scoped store per HTTP callback, never a shared per-user singleton.
  let taken = false;
  let publication: { connectionId: string; orgId: string; generation: string; epoch: string } | undefined;
  async function current(connectionId: string) {
    const r = await sql.query<{ org_id: string; generation: number }>(
      `select c.org_id,g.generation from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id
       where c.id=$1::uuid and not c.disabled and g.revoked_at is null`,
      [connectionId],
    );
    if (!r.rows[0]) throw new Error("MCP connection is disabled or revoked.");
    return r.rows[0];
  }
  return {
    generation: async (id) => String((await current(id)).generation),
    async readGrant(id): Promise<StoredGrant | null> {
      const r = await sql.query<{ generation: number; version: number; value_enc: Uint8Array }>(
        `select g.generation,g.version,g.value_enc from public.mcp_grants g join public.mcp_connections c on c.id=g.connection_id
         where c.id=$1::uuid and not c.disabled and g.revoked_at is null and g.status in ('connected','unavailable') and g.value_enc is not null and not (g.refresh_consumed and g.refresh_until<=now())`,
        [id],
      );
      const row = r.rows[0];
      return row
        ? {
            generation: String(row.generation),
            version: String(row.version),
            sealed: Buffer.from(row.value_enc).toString("base64"),
          }
        : null;
    },
    async saveGrant(id, version, sealed, generation, owner) {
      const context = publication;
      if (publicationSignal?.aborted) return false;
      if (
        owner === undefined &&
        (!callbackActorId || !context || context.connectionId !== id || context.generation !== generation)
      )
        return false;
      publication = undefined;
      const r = await sql.query(
        `with callback_member as materialized (
           select org_id,user_id,role from public.members where org_id=$8::uuid and user_id=$6::uuid for share),
         callback_epoch as materialized (
           select e.epoch,m.role from public.mcp_actor_epochs e join callback_member m on m.org_id=e.org_id and m.user_id=e.user_id
           where e.epoch=$7::bigint for share of e)
         update public.mcp_grants g set value_enc=$4::bytea,version=version+1,status='connected',
           refresh_consumed=false,refresh_owner=null,refresh_until=null
         where g.connection_id=$1::uuid and g.generation=$2::integer and g.revoked_at is null
           and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and not c.disabled and c.auth_type='oauth')
           and ($5::uuid is not null or ($6::uuid is not null and $7::bigint is not null and $8::uuid is not null
             and exists(select 1 from public.mcp_connections c cross join callback_epoch e
               where c.id=g.connection_id and c.org_id=$8::uuid
               and ((c.scope='personal' and c.owner_id=$6::uuid) or (c.scope='org' and e.role='admin')))))
           and (($3::integer is null and $5::uuid is null and g.status<>'connected' and not g.refresh_consumed)
             or (g.version=$3::integer and (($5::uuid is null and not g.refresh_consumed)
               or (g.refresh_consumed and g.refresh_owner=$5::uuid and g.refresh_until>now())))) returning g.id`,
        [
          id,
          generation,
          version,
          new Uint8Array(Buffer.from(sealed, "base64")),
          owner ?? null,
          callbackActorId ?? null,
          context?.epoch ?? null,
          context?.orgId ?? null,
        ],
      );
      return r.rows.length === 1;
    },
    async claimRefresh(id, version, generation, owner) {
      const r = await sql.query(
        `update public.mcp_grants g set refresh_consumed=true,refresh_owner=$4::uuid,refresh_until=now()+interval '30 seconds'
         where g.connection_id=$1::uuid and g.version=$2::integer and g.generation=$3::integer
           and g.revoked_at is null and not g.refresh_consumed and g.status in ('connected','unavailable')
           and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and not c.disabled)
         returning g.id`,
        [id, version, generation, owner],
      );
      return r.rows.length === 1;
    },
    async revoke(id) {
      await sql.query(
        `update public.mcp_grants set generation=generation+1,version=version+1,value_enc=null,
        revoked_at=now(),status='not_connected',refresh_owner=null,refresh_until=null where connection_id=$1::uuid`,
        [id],
      );
    },
    async putPending(hash, record) {
      const row = await current(record.connectionId);
      const flow = JSON.parse(await createMcpSecretBox(key).open(record.sealed)) as { generation?: unknown };
      if (typeof flow.generation !== "string" || !/^[1-9][0-9]*$/.test(flow.generation))
        throw new Error("Invalid pending OAuth generation.");
      const epoch =
        (
          await sql.query<{ epoch: string }>(
            "select epoch::text as epoch from public.mcp_actor_epochs where org_id=$1::uuid and user_id=$2::uuid",
            [row.org_id, record.actorId],
          )
        ).rows[0]?.epoch ?? "0";
      await pending.put({
        stateHash: hash,
        actorId: record.actorId,
        orgId: row.org_id,
        connectionId: record.connectionId,
        generation: Number(flow.generation),
        payload: JSON.stringify({ sealed: record.sealed, expiresAt: record.expiresAt, actorEpoch: epoch }),
        expiresAt: new Date(record.expiresAt),
      });
    },
    async takePending(hash, actorId, now) {
      // The durable port uses database time, not a client-supplied deadline.
      void now;
      if (callbackActorId && (taken || callbackActorId !== actorId)) return null;
      if (callbackActorId) taken = true;
      const flow = await pending.take(actorId, hash);
      const payload = flow
        ? (JSON.parse(flow.payload) as { sealed: string; expiresAt: number; actorEpoch?: string })
        : null;
      if (!flow || !payload || typeof payload.actorEpoch !== "string" || !/^\d+$/.test(payload.actorEpoch)) return null;
      if (callbackActorId)
        publication = {
          connectionId: flow.connectionId,
          orgId: flow.orgId,
          generation: String(flow.generation),
          epoch: payload.actorEpoch,
        };
      return flow && payload
        ? {
            actorId: flow.actorId,
            connectionId: flow.connectionId,
            sealed: payload.sealed,
            expiresAt: payload.expiresAt,
          }
        : null;
    },
  };
}
