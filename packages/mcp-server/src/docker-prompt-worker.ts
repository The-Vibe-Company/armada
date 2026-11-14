import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createDockerNormalSend } from "./docker-normal-send.ts";
import { createDockerQueuedPrompts, type QueuedDockerPrompt } from "./docker-queued-prompts.ts";
import { createDockerSandboxControls } from "./docker-sandbox-controls.ts";

export function createDockerPromptWorker(sql: Sql, key: string, options: Parameters<typeof createDockerNormalSend>[2]) {
  const active = new Set<Promise<void>>();
  let stopping = false;
  const controls = createDockerSandboxControls(sql, key);
  const sender = createDockerNormalSend(sql, key, { ...options, dispatchQueued: true });
  const queue = createDockerQueuedPrompts(sql, key);
  async function drain() {
    if (stopping || active.size >= 8) return;
    const work = (async () => {
      await queue.failCancelled();
      const worker = randomUUID();
      const q = (
        await sql.query<QueuedDockerPrompt & { org_id: string; role: "admin" | "member" }>(
          `update public.docker_queued_prompts q set status='dispatching',worker_id=$1,worker_expires_at=now()+interval '30 seconds'
        where q.position=(select p.position from public.docker_queued_prompts p join public.sandboxes s on s.id=p.sandbox_id
          join public.docker_launch_requests d on d.sandbox_id=s.id join public.members m on m.user_id=p.owner_id and m.org_id=s.org_id
          join public.mcp_actor_epochs e on e.user_id=m.user_id and e.org_id=m.org_id and e.epoch=p.actor_epoch
          where p.status in ('queued','dispatching') and (p.worker_expires_at is null or p.worker_expires_at<=now())
          and d.result_enc is not null and s.status in ('ready','running') and s.stop_requested_at is null and s.expires_at>now()
          and s.lifecycle_generation=p.lifecycle_generation and s.owner_id=p.owner_id
          and not exists(select 1 from public.docker_queued_prompts earlier where earlier.sandbox_id=p.sandbox_id and earlier.position<p.position and earlier.status in ('queued','dispatching'))
          order by p.position limit 1 for update of p skip locked)
        returning q.*,(select org_id from public.sandboxes where id=q.sandbox_id) as org_id,
          (select m.role from public.members m join public.sandboxes s on s.org_id=m.org_id where s.id=q.sandbox_id and m.user_id=q.owner_id) as role`,
          [worker],
        )
      ).rows[0];
      if (!q) return;
      const caller: Caller = { userId: q.owner_id, orgs: [{ orgId: q.org_id, role: q.role }], via: "service" };
      const renew = setInterval(() => {
        void sql
          .query(
            "update public.docker_queued_prompts set worker_expires_at=now()+interval '30 seconds' where sandbox_id=$1 and request_id=$2 and worker_id=$3 and worker_expires_at>now()",
            [q.sandbox_id, q.request_id, worker],
          )
          .catch(() => {});
      }, 10000);
      try {
        const previous = (
          await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
            "select request_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
            [q.sandbox_id, `docker_prompt_${q.request_id}`],
          )
        ).rows[0];
        if (!previous && !(await controls.canDispatchQueued(caller, q.sandbox_id))) return;
        const plaintext = await decryptSecret(q.input_enc, key);
        if (createHash("sha256").update(plaintext).digest("hex") !== q.input_hash)
          throw Error("queued prompt identity mismatch");
        const payload = JSON.parse(plaintext) as {
          prompt: string;
          conversationId: string | null;
        };
        const row = (
          await sql.query<{
            id: string;
            org_id: string;
            owner_id: string;
            status: string;
            conversation_ids: string[];
            docker_snapshot_id: string | null;
          }>("select id,org_id,owner_id,status,conversation_ids,docker_snapshot_id from public.sandboxes where id=$1", [
            q.sandbox_id,
          ])
        ).rows[0];
        if (!row) return;
        const conversationId = previous
          ? (JSON.parse(await decryptSecret(previous.request_enc, key)).input.conversationId as string | undefined)
          : (q.conversation_id ?? payload.conversationId ?? undefined);
        const result = await sender.send(
          caller,
          {
            request_id: q.request_id,
            prompt: payload.prompt,
            ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
          },
          row,
        );
        if (!result.conversationId) throw Error("queued prompt dispatch unavailable");
        await sql.query(
          "update public.docker_queued_prompts set status='admitted',native_prompt_id=$4,native_conversation_id=$5,conversation_id=coalesce(conversation_id,$5) where sandbox_id=$1 and request_id=$2 and worker_id=$3 and worker_expires_at>now() and status='dispatching'",
          [q.sandbox_id, q.request_id, worker, result.promptId, result.conversationId],
        );
      } catch {
        // An already queued native command can have an unknown receipt: reconcile it, never dispatch twice.
        const native = (
          await sql.query<{ result_enc: Uint8Array<ArrayBuffer> | null }>(
            "select result_enc from public.runtime_commands where sandbox_id=$1 and request_id=$2",
            [q.sandbox_id, `docker_prompt_${q.request_id}`],
          )
        ).rows[0];
        let unknown = !!native;
        if (native?.result_enc) {
          const reply = JSON.parse(await decryptSecret(native.result_enc, key));
          unknown =
            reply.status === 200 &&
            typeof reply.body?.result?.promptId === "string" &&
            typeof reply.body?.result?.conversationId === "string";
        }
        if (!unknown)
          await sql.query(
            "update public.docker_queued_prompts set status='failed',failure_reason=$4,failure_native_sequence=(select coalesce(max(c.sequence),0) from public.runtime_commands c where c.sandbox_id=public.docker_queued_prompts.sandbox_id and starts_with(c.request_id,'docker_prompt_')) where sandbox_id=$1 and request_id=$2 and worker_id=$3 and status='dispatching'",
            [
              q.sandbox_id,
              q.request_id,
              worker,
              "Queued Docker prompt admission failed. Inspect sandbox status and the runtime connection.",
            ],
          );
      } finally {
        clearInterval(renew);
        await sql.query(
          "update public.docker_queued_prompts set worker_id=null,worker_expires_at=null where sandbox_id=$1 and request_id=$2 and worker_id=$3",
          [q.sandbox_id, q.request_id, worker],
        );
      }
    })().finally(() => active.delete(work));
    active.add(work);
    return work;
  }
  return {
    drain,
    async close() {
      stopping = true;
      await Promise.allSettled([...active]);
    },
  };
}
