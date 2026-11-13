import type { AgentEvent, Sql } from "@armada/core";
import { HARNESS_KINDS, PROMPT_STATUSES } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

type Actor = { userId: string; orgId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scopedSql = (tx: Sql): Sql => ({ query: tx.query.bind(tx), transaction: (work) => work(tx) });
export class DockerRuntimeDenied extends Error {
  constructor() {
    super("Docker runtime denied");
    this.name = "DockerRuntimeDenied";
  }
}
function deny(): never {
  throw new DockerRuntimeDenied();
}
function identity(actor: Actor, sandboxId: string) {
  if (
    !actor ||
    Object.keys(actor).sort().join() !== "orgId,userId" ||
    !uuid.test(actor.userId) ||
    !uuid.test(actor.orgId) ||
    !uuid.test(sandboxId)
  )
    deny();
}
function result(
  reply: { epoch: string; requestId: string; status: number; body: Record<string, unknown> },
  epoch: string,
  requestId: string,
) {
  if (
    reply.epoch !== epoch ||
    reply.requestId !== requestId ||
    reply.status !== 200 ||
    reply.body.version !== 1 ||
    reply.body.requestId !== requestId ||
    !object(reply.body.result) ||
    Object.hasOwn(reply.body, "error")
  )
    deny();
  return reply.body.result;
}
/** One native conversation per allocation. No provider projection or network/waiting in this service. */
export function createDockerRuntimeLifecycle(sql: Sql, key: string, options: { enabled?: boolean } = {}) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    try {
      if (!sql.transaction) deny();
      return await sql.transaction(work);
    } catch {
      return deny();
    }
  }
  async function admitted<T>(
    actor: Actor,
    sandboxId: string,
    work: (
      tx: Sql,
      authority: ReturnType<typeof createRuntimeEnrolments>,
      sandbox: Awaited<ReturnType<ReturnType<typeof createDockerSandboxService>["get"]>>,
      epoch: string,
    ) => Promise<T>,
    allowPending = false,
  ) {
    return transaction(async (tx) => {
      if (options.enabled !== true) deny();
      identity(actor, sandboxId);
      const scoped = scopedSql(tx);
      const authority = createRuntimeEnrolments(scoped, key);
      const snapshot = await createDockerSandboxService(scoped, key).get(actor, sandboxId);
      if (snapshot.ownerId !== actor.userId) deny();
      // Same order as bootstrap, native publication and source revocation: membership,
      // then account, then host/sandbox/runtime. withOwner reuses this transaction.
      const source = await authority.lockSourceMembers(tx, sandboxId, actor.userId);
      const credential = await tx.query(
        `select id from public.credentials where id=$1 and version=$2 and kind = any($5::public.credential_kind[])
         and status='active' and (expires_at is null or expires_at>now())
         and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
        [snapshot.credentialId, snapshot.credentialVersion, actor.userId, actor.orgId, HARNESS_KINDS[snapshot.harness]],
      );
      if (!credential.rows.length) deny();
      if (allowPending) {
        const host = await tx.query(
          `select h.id from public.docker_hosts h join public.members m on m.org_id=h.org_id and m.user_id=h.owner_id
           where h.id=$1 and h.org_id=$2 and h.installation_id=$3 and h.hash is not null
           and h.registration_hash is null and h.revoked_at is null and h.owner_id=$4 for share of h`,
          [snapshot.hostId, actor.orgId, snapshot.installationId, source.issuer_id],
        );
        if (!host.rows.length) deny();
        const live = await tx.query(
          `select id from public.sandboxes where id=$1 and status in ('starting','ready','running')
           and stop_requested_at is null and deleted_at is null and expires_at>now() for update`,
          [sandboxId],
        );
        if (!live.rows.length) deny();
      }
      const phases = await tx.query(
        `select 1 from public.docker_host_jobs j join public.mcp_actor_epochs e
         on e.org_id=$3 and e.user_id=$2 and e.epoch=j.bound_actor_epoch
         where j.bound_sandbox_id=$1 and j.bound_actor_id=$2 and j.host_id=$4
         and j.bound_operation='create' and j.outcome='completed'
         and exists(select 1 from public.docker_host_jobs b where b.bound_sandbox_id=$1
           and b.bound_operation in ('bootstrap','resume') and b.bound_actor_id=$2 and b.host_id=$4
           and b.bound_actor_epoch=e.epoch and b.outcome is distinct from 'failed')`,
        [sandboxId, actor.userId, actor.orgId, snapshot.hostId],
      );
      if (!phases.rows.length) deny();
      if (allowPending) {
        const pending = await tx.query(
          `select 1 from public.runtime_enrolments r join public.sandboxes s on s.id=r.sandbox_id
           where r.sandbox_id=$1 and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is null
           and r.enrolment_hash is not null and r.enrolment_expires_at>now()
           and r.docker_issuer_fence=$2 for update of r`,
          [sandboxId, source.docker_issuer_fence],
        );
        if (pending.rows.length) return { state: "pending" as const };
      }
      return authority.withOwner(sandboxId, actor.userId, async (_fenced, scope) => {
        const current = await createDockerSandboxService(scoped, key).get(actor, sandboxId);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) deny();
        return work(scoped, authority, current, scope.epoch);
      });
    });
  }
  return {
    ready(actor: Actor, sandboxId: string, requestId: string) {
      if (!uuid.test(requestId)) return Promise.reject(new DockerRuntimeDenied());
      return admitted(
        actor,
        sandboxId,
        async (_tx, authority) => {
          const id = `docker_health_${requestId}`;
          const commands = createRuntimeCommands(authority, key);
          const queued = await commands.enqueue(actor.userId, { version: 1, requestId: id, sandboxId, op: "health" });
          const response = await commands.result(actor.userId, sandboxId, id, queued.epoch);
          if (response.state === "pending") return { state: "pending" as const };
          if (response.state !== "finished") deny();
          const health = result(response.reply, queued.epoch, id);
          if (health.generation !== queued.epoch || typeof health.ready !== "boolean") deny();
          if (!health.ready) deny();
          return authority.withOwner(sandboxId, actor.userId, async (fenced, scope) => {
            if (scope.epoch !== queued.epoch) deny();
            // Private lane status transitions must not revoke their own live epoch.
            await fenced.query(`update public.sandboxes set status='ready' where id=$1 and status='starting'`, [
              sandboxId,
            ]);
            return { state: "ready" as const, epoch: scope.epoch };
          });
        },
        true,
      );
    },
    prompt(actor: Actor, sandboxId: string, input: { requestId: string; text: string; conversationId?: string }) {
      return admitted(actor, sandboxId, async (tx, authority, sandbox, epoch) => {
        if (
          !object(input) ||
          Object.keys(input).some((field) => !["requestId", "text", "conversationId"].includes(field)) ||
          (Object.hasOwn(input, "conversationId") &&
            (typeof input.conversationId !== "string" || !uuid.test(input.conversationId))) ||
          !uuid.test(input.requestId) ||
          typeof input.text !== "string" ||
          !input.text.trim() ||
          Buffer.byteLength(input.text) > 262144 ||
          !["ready", "running"].includes(sandbox.status)
        )
          deny();
        const id = `docker_prompt_${input.requestId}`;
        // Exact retries keep their original canonical payload, including the first
        // request's absent conversationId, even after its receipt is reconciled.
        const previous = await tx.query(
          `select request_id from public.runtime_commands where sandbox_id=$1 and request_id=$2`,
          [sandboxId, id],
        );
        const saved =
          (
            await tx.query<{ conversation_ids: string[] }>(
              `select conversation_ids from public.sandboxes where id=$1 and org_id=$2 and owner_id=$3`,
              [sandboxId, actor.orgId, actor.userId],
            )
          ).rows[0]?.conversation_ids ?? deny();
        if (!previous.rows.length) {
          if (saved.length > 1 || saved.some((conversationId) => !uuid.test(conversationId))) deny();
          if (saved.length ? input.conversationId !== saved[0] : input.conversationId !== undefined) deny();
          const blocked = await tx.query(
            `select 1 from public.runtime_commands where sandbox_id=$1
             and starts_with(request_id,'docker_prompt_')
             and ((epoch=$3::bigint and result_enc is null) or $2::boolean) limit 1`,
            [sandboxId, saved.length === 0, epoch],
          );
          // An unresolved RPC has not established native admission yet. Once it
          // replies, the runner alone owns busy/refusal; no journal scheduler here.
          if (blocked.rows.length) deny();
        }
        const commands = createRuntimeCommands(authority, key);
        const queued = await commands.enqueue(actor.userId, {
          version: 1,
          requestId: id,
          sandboxId,
          op: "prompt",
          input: {
            sandboxId,
            harness: sandbox.harness,
            text: input.text,
            ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
            model: sandbox.model,
            reasoningEffort: sandbox.reasoningEffort,
            cwd: "/home/user",
          },
        });
        await tx.query(`update public.sandboxes set status='running' where id=$1 and status='ready'`, [sandboxId]);
        const response = await commands.result(actor.userId, sandboxId, id, queued.epoch);
        if (response.state === "pending") return { state: "pending" as const };
        if (response.state !== "finished") deny();
        const receipt = result(response.reply, queued.epoch, id);
        if (
          typeof receipt.promptId !== "string" ||
          !uuid.test(receipt.promptId) ||
          typeof receipt.conversationId !== "string" ||
          !uuid.test(receipt.conversationId) ||
          !PROMPT_STATUSES.some((status) => status === receipt.status) ||
          (input.conversationId !== undefined && receipt.conversationId !== input.conversationId) ||
          saved.length > 1 ||
          (saved.length === 1 && receipt.conversationId !== saved[0])
        )
          deny();
        if (!saved.length) {
          // This service-owned projection must not advance lifecycle_generation.
          await tx.query(`update public.sandboxes set conversation_ids=array[$2]::text[] where id=$1`, [
            sandboxId,
            receipt.conversationId,
          ]);
        }
        return {
          state: "admitted" as const,
          epoch: queued.epoch,
          receipt: {
            promptId: receipt.promptId,
            conversationId: receipt.conversationId,
            status: receipt.status as (typeof PROMPT_STATUSES)[number],
          },
        };
      });
    },
    journal(actor: Actor, sandboxId: string, input: { cursor?: string; limit?: number } = {}) {
      return transaction(async (tx) => {
        identity(actor, sandboxId);
        const cursor = input.cursor ?? "0",
          limit = input.limit ?? 100;
        if (
          !object(input) ||
          Object.keys(input).some((k) => !["cursor", "limit"].includes(k)) ||
          !/^(0|[1-9][0-9]{0,18})$/.test(cursor) ||
          BigInt(cursor) > 9223372036854775807n ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          deny();
        // Retained archive authorization deliberately does not require a live host,
        // epoch, account or enabled launch flag, including after stop/delete.
        const member = await tx.query(`select user_id from public.members where org_id=$1 and user_id=$2 for share`, [
          actor.orgId,
          actor.userId,
        ]);
        if (!member.rows.length) deny();
        const row =
          (
            await tx.query<{ usage: unknown }>(
              `select usage_turns as usage from public.sandboxes where id=$1 and org_id=$2 and owner_id=$3
           and provider='docker' for share`,
              [sandboxId, actor.orgId, actor.userId],
            )
          ).rows[0] ?? deny();
        const rows = (
          await tx.query<{ sequence: string; event_enc: Uint8Array<ArrayBuffer> }>(
            `select sequence::text,event_enc from public.runtime_events where sandbox_id=$1 and sequence>$2::bigint
           order by sequence limit $3`,
            [sandboxId, cursor, limit + 1],
          )
        ).rows;
        const events: { sequence: string; event: AgentEvent }[] = [];
        // Saved usage is a service-owned projection, not a guest/native blob.
        const usage = row.usage;
        let bytes = Buffer.byteLength(JSON.stringify({ usage, events: [], cursor, hasMore: true }));
        if (bytes > 1048576) deny();
        for (const row of rows.slice(0, limit)) {
          const event = JSON.parse(await decryptSecret(row.event_enc, key)) as AgentEvent;
          const item = { sequence: row.sequence, event };
          const size = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes + size > 1048500) break;
          events.push(item);
          bytes += size;
        }
        return { events, cursor: events.at(-1)?.sequence ?? cursor, hasMore: rows.length > events.length, usage };
      });
    },
  };
}
