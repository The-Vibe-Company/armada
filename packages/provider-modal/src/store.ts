import { createHash, randomUUID } from "node:crypto";
import {
  type AgentEvent,
  buildEventPage,
  type EventPage,
  eventPageOptions,
  ProviderError,
  type Sql,
} from "@armada/core";
import { refusal } from "./errors.ts";
import type { IngestPayload, Machine, ModalStore, SavedImage, Scope } from "./ports.ts";

export function scopeKey(scope: Scope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.orgId,
        scope.visibility,
        scope.visibility === "private" ? scope.userId : null,
        scope.binding.workspace,
        scope.binding.environment,
        scope.binding.appId,
      ]),
    )
    .digest("hex");
}
function revive(row: Machine): Machine {
  for (const key of ["createdAt", "expiresAt", "stoppedAt"] as const)
    if (row.info[key]) row.info[key] = new Date(row.info[key]);
  return row;
}
/** Requires a server connection and authenticated caller. Every SQL query includes scope; every
 * controller entry rechecks live org membership (including private owner), not cached authorization. */
export function createSqlModalStore(sql: Sql, scope: Scope): ModalStore {
  const key = scopeKey(scope);
  async function authorize(db = sql) {
    const result = await db.query(`select 1 from public.members where org_id=$1 and user_id=$2`, [
      scope.orgId,
      scope.userId,
    ]);
    if (!result.rows.length) throw refusal("forbidden", "Organization membership required.");
  }
  async function get(id: string, db = sql): Promise<Machine> {
    await authorize(db);
    const result = await db.query<{ record: Machine }>(
      `select record from public.modal_machines where scope=$1 and id=$2 and org_id=$3 and (visibility='org' or owner_id=$4)`,
      [key, id, scope.orgId, scope.userId],
    );
    const row = result.rows[0];
    if (!row) throw refusal("not_found", "Modal sandbox not found.");
    return revive(row.record);
  }
  return {
    async findByRequestKey(requestKey) {
      await authorize();
      const result = await sql.query<{ id: string; record: Machine }>(
        "select id,record from public.modal_machines where scope=$1 and request_key=$2 and org_id=$3 and owner_id=$4 and visibility=$5::public.visibility",
        [key, requestKey, scope.orgId, scope.userId, scope.visibility],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.record.info.id !== row.id)
        throw refusal("forbidden", "Stored builder identity does not match its reservation.");
      return revive(row.record);
    },
    async reserve(requestKey, machine, tx = sql) {
      await authorize(tx);
      await tx.query(
        `insert into public.modal_machines(scope,org_id,owner_id,visibility,id,request_key,record) values($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict(scope,request_key) do nothing`,
        [key, scope.orgId, scope.userId, scope.visibility, machine.info.id, requestKey, JSON.stringify(machine)],
      );
      const result = await tx.query<{ record: Machine }>(
        `select record from public.modal_machines where scope=$1 and request_key=$2`,
        [key, requestKey],
      );
      const row = result.rows[0];
      if (!row) throw refusal("conflict", "Launch reservation failed.");
      return revive(row.record);
    },
    async withForkSource(id, pin) {
      if (!sql.transaction)
        throw refusal("provider_routing_unavailable", "Transactional SQL is required to pin a Modal fork source.");
      return sql.transaction(async (tx) => {
        await get(id, tx);
        // Lifecycle mutations claim this same row before touching its images.
        // A transactional row lock protects the target reservation even if the
        // process dies before it can release its claim.
        const locked = await tx.query(
          `select id from public.modal_machines where scope=$1 and id=$2
           and (lease_until is null or lease_until<=clock_timestamp()) for update skip locked`,
          [key, id],
        );
        if (!locked.rows.length)
          throw new ProviderError({
            provider: "modal",
            code: "conflict",
            providerCode: "fork_source_busy",
            message: "The Modal snapshot source is busy. No sandbox was created by this attempt.",
            retryable: true,
          });
        return pin(await get(id, tx), tx);
      });
    },
    get,
    async watermark(id, generation) {
      const row = await get(id);
      if (row.generation !== generation) throw refusal("conflict", "Event generation changed.");
      const result = await sql.query<{ ack: string }>(
        `select coalesce(max(producer_sequence),$4)::text as ack from public.modal_events where scope=$1 and sandbox_id=$2 and generation=$3`,
        [key, id, String(generation), row.eventBase ?? 0],
      );
      return Number(result.rows[0]?.ack ?? row.eventBase ?? 0);
    },
    async list() {
      await authorize();
      const result = await sql.query<{ record: Machine }>(
        `select record from public.modal_machines where scope=$1 and org_id=$2 and (visibility='org' or owner_id=$3)`,
        [key, scope.orgId, scope.userId],
      );
      return result.rows.map((x) => revive(x.record));
    },
    async lease(id, work, mode) {
      await get(id);
      const token = randomUUID();
      // Durable boot retries need to outlive a crashed adapter lease. Renew
      // while the process is alive, including during slow Modal calls.
      const duration = mode === "launch" ? 45 : 900;
      const claim = await sql.query(
        `update public.modal_machines set lease_id=$3,lease_until=clock_timestamp()+$4::integer*interval '1 second' where scope=$1 and id=$2 and (lease_until is null or lease_until<=clock_timestamp()) returning id`,
        [key, id, token, duration],
      );
      if (!claim.rows.length)
        throw new ProviderError({
          provider: "modal",
          code: "conflict",
          providerCode: "lifecycle_lease_busy",
          message: "Sandbox lifecycle is leased by another controller.",
          retryable: true,
        });
      const heartbeat =
        mode === "launch"
          ? setInterval(() => {
              void sql
                .query(
                  `update public.modal_machines set lease_until=clock_timestamp()+$4::integer*interval '1 second'
           where scope=$1 and id=$2 and lease_id=$3 and lease_until>clock_timestamp()`,
                  [key, id, token, duration],
                )
                .catch(() => {});
            }, 10_000)
          : undefined;
      heartbeat?.unref();
      try {
        return await work(await get(id), async (row) => {
          await authorize(sql);
          const result = await sql.query(
            `update public.modal_machines set record=$4::jsonb,lease_until=clock_timestamp()+$5::integer*interval '1 second' where scope=$1 and id=$2 and lease_id=$3 and lease_until>clock_timestamp() returning id`,
            [key, id, token, JSON.stringify(row), duration],
          );
          if (!result.rows.length) throw refusal("conflict", "Lifecycle lease expired; result is fenced.");
        });
      } finally {
        clearInterval(heartbeat);
        await sql.query(
          `update public.modal_machines set lease_id=null,lease_until=null where scope=$1 and id=$2 and lease_id=$3`,
          [key, id, token],
        );
      }
    },
    async image(name, tx = sql) {
      await authorize(tx);
      const result = await tx.query<{ record: SavedImage }>(
        `select record from public.modal_images where scope=$1 and name=$2`,
        [key, name],
      );
      const row = result.rows[0];
      if (!row || row.record.deleted) throw refusal("not_found", "Modal snapshot not found.");
      return row.record;
    },
    async saveImage(image) {
      await get(image.sourceId);
      const result = await sql.query(
        `insert into public.modal_images(scope,name,source_id,record) values($1,$2,$3,$4::jsonb) on conflict(scope,name) do update set record=excluded.record where modal_images.source_id=excluded.source_id and modal_images.record->'info'->>'status'='saving' returning name`,
        [key, image.info.name, image.sourceId, JSON.stringify(image)],
      );
      if (!result.rows.length) throw refusal("conflict", "Snapshot name is already immutable.");
    },
    async removeImage(name) {
      await authorize();
      await sql.query(
        `update public.modal_images set record=jsonb_set(record,'{deleted}','true') where scope=$1 and name=$2`,
        [key, name],
      );
    },
    async purgeImage(name, sourceId, imageId) {
      await authorize();
      // Conditional on the exact claimed artifact: a stale collector finishing late never erases
      // a later tombstone that reused the name for another source or image.
      await sql.query(
        `delete from public.modal_images where scope=$1 and name=$2 and source_id=$3 and record->>'imageId'=$4 and record->>'deleted'='true'`,
        [key, name, sourceId, imageId],
      );
    },
    async claimImage(name, sourceId, imageId) {
      await authorize();
      await sql.query(
        `update public.modal_images set record=jsonb_set(record,'{collecting}','true') where scope=$1 and name=$2 and source_id=$3 and record->>'imageId'=$4 and record->>'deleted'='true'`,
        [key, name, sourceId, imageId],
      );
    },
    async takeImage(name, sourceId, imageId, token) {
      await authorize();
      // Five minutes bounds one image deletion; a crashed holder's claim is then recoverable.
      const result = await sql.query(
        `update public.modal_images set record=record||jsonb_build_object('collectToken',$5::text,'collectUntil',extract(epoch from now()+interval '5 minutes'))
         where scope=$1 and name=$2 and source_id=$3 and record->>'imageId'=$4 and record->>'deleted'='true' and record->>'collecting'='true'
         and (record->>'collectUntil' is null or (record->>'collectUntil')::double precision<extract(epoch from now())) returning name`,
        [key, name, sourceId, imageId, token],
      );
      return result.rows.length > 0;
    },
    async releaseImage(name, sourceId, imageId, token) {
      await authorize();
      await sql.query(
        `update public.modal_images set record=record-'collectToken'-'collectUntil' where scope=$1 and name=$2 and source_id=$3 and record->>'imageId'=$4 and record->>'collectToken'=$5`,
        [key, name, sourceId, imageId, token],
      );
    },
    async images(sourceId) {
      await get(sourceId);
      const result = await sql.query<{ record: SavedImage }>(
        `select record from public.modal_images where scope=$1 and source_id=$2`,
        [key, sourceId],
      );
      return result.rows.map((x) => x.record);
    },
    async tombstoneSources() {
      await authorize();
      const result = await sql.query<{ id: string }>(
        `select distinct m.id from public.modal_images i join public.modal_machines m on m.scope=i.scope and m.id=i.source_id
         where i.scope=$1 and i.record->>'deleted'='true' and m.org_id=$2 and (m.visibility='org' or m.owner_id=$3)`,
        [key, scope.orgId, scope.userId],
      );
      return result.rows.map((x) => x.id);
    },
    async imageReferenced(imageId) {
      await authorize();
      // Authorization limits what this store may delete; references protect the
      // immutable physical ID across all bindings/tenant scopes, without exposing them.
      const result = await sql.query(
        `select 1 where exists(select 1 from public.modal_images i where i.record->>'imageId'=$1 and (i.record->>'deleted') is distinct from 'true')
        or exists(select 1 from public.modal_machines m where m.record->>'phase' is distinct from 'deleted' and (
          m.record->>'imageId'=$1 or m.record->>'recoveryImageId'=$1 or m.record->'sourceImage'->>'imageId'=$1 or (m.record->'retainedRecoveryIds') ? $1
        )) limit 1`,
        [imageId],
      );
      return result.rows.length > 0;
    },
    async latestPrompt(sandboxId, promptId) {
      await get(sandboxId);
      const result = await sql.query<{ event: Extract<AgentEvent, { kind: "prompt" }> }>(
        `select event from public.modal_events where scope=$1 and sandbox_id=$2
         and event->>'kind'='prompt' and event->>'promptId'=$3
         order by cursor desc limit 1`,
        [key, sandboxId, promptId],
      );
      return result.rows[0]?.event ?? null;
    },
    async events(input): Promise<EventPage> {
      await get(input.sandboxId);
      const { limit, backward } = eventPageOptions(input, "modal");
      if (input.cursor && !/^\d+$/.test(input.cursor)) throw refusal("invalid_request", "Invalid event pagination.");
      const result = await sql.query<{ cursor: string; event: AgentEvent }>(
        `select cursor::text,event from public.modal_events where scope=$1 and sandbox_id=$2 and ($3::bigint is null or cursor${backward ? "<" : ">"}$3::bigint) and ($4::text is null or event->>'conversationId'=$4) order by public.modal_events.cursor ${backward ? "desc" : "asc"} limit $5`,
        [key, input.sandboxId, input.cursor ?? (backward ? null : "0"), input.conversationId ?? null, limit + 1],
      );
      return buildEventPage(result.rows.slice(0, limit), input, result.rows.length > limit, "modal");
    },
  };
}
/** Only called after verifying an expiring, sandbox+generation scoped ingest grant. No caller DB
 * credentials or provider tokens are ever sent to a runner. Ack follows transaction commit. */
export async function appendModalEvents(
  sql: Sql,
  scope: Scope,
  sandboxId: string,
  generation: string,
  events: Omit<IngestPayload, "sandboxId" | "generation">[],
  projectEvents?: (tx: Sql, events: AgentEvent[]) => Promise<void>,
): Promise<number> {
  if (!sql.transaction)
    throw refusal("provider_routing_unavailable", "Transactional SQL is required for event ingestion.");
  const key = scopeKey(scope);
  return sql.transaction(async (db) => {
    const member = await db.query(`select 1 from public.members where org_id=$1 and user_id=$2`, [
      scope.orgId,
      scope.userId,
    ]);
    if (!member.rows.length) throw refusal("forbidden", "Organization membership revoked.");
    const row = (
      await db.query<{ record: Machine }>(
        `select record from public.modal_machines where scope=$1 and id=$2 for update`,
        [key, sandboxId],
      )
    ).rows[0];
    if (
      !row ||
      String(row.record.generation) !== generation ||
      !["booting", "active", "checkpoint"].includes(row.record.phase)
    )
      throw refusal("forbidden", "Runner generation is fenced.");
    const previous = await db.query<{ ack: string }>(
      `select coalesce(max(producer_sequence),$4)::text as ack from public.modal_events where scope=$1 and sandbox_id=$2 and generation=$3`,
      [key, sandboxId, generation, row.record.eventBase ?? 0],
    );
    let ack = Number(previous.rows[0]?.ack ?? 0);
    const accepted: AgentEvent[] = [];
    for (const item of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1)
        throw refusal("invalid_request", "Invalid producer sequence.");
      if (item.sequence > ack + 1) break; // Never publish an event beyond a producer gap.
      const inserted = await db.query(
        `insert into public.modal_events(scope,sandbox_id,generation,producer_sequence,event) values($1,$2,$3,$4,$5::jsonb)
         on conflict(scope,sandbox_id,generation,producer_sequence) do update set event=excluded.event
         where modal_events.event=excluded.event returning cursor`,
        [key, sandboxId, generation, item.sequence, JSON.stringify(item.event)],
      );
      if (!inserted.rows.length) throw refusal("conflict", "Producer replay differs from committed event.");
      accepted.push(item.event);
      ack = Math.max(ack, item.sequence);
    }
    if (accepted.length) await projectEvents?.(db, accepted);
    return ack;
  });
}
