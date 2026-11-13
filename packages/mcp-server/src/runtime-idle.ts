import { type AgentEvent, decryptSecret, isFinalPromptStatus, type Sql } from "@armada/core/server";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";

/** Unknown/truncated history cannot prove idle. Detached processes follow the timer,
 * not process inspection: only an active turn or admitted command blocks pause. */
export function runtimeIdle(events: readonly AgentEvent[], now: number, delay: number): boolean {
  const turns = new Map<string, boolean>();
  let last = 0;
  for (const event of events) {
    last = Math.max(last, event.at);
    if (event.kind === "prompt") {
      if (!event.promptId) return false;
      turns.set(event.promptId, isFinalPromptStatus(event.status));
    }
  }
  return turns.size > 0 && [...turns.values()].every(Boolean) && last > 0 && now - last >= delay;
}

/** The checkpoint transaction owns the sandbox row before rechecking idle. Its durable
 * intent fences sends before any RPC; uncertainty never dispatches a compute stop. */
export function createRuntimeIdle(
  sql: Sql,
  key: string,
  checkpoint: RuntimeCheckpoint,
  options: { delayMs?: number; now?: () => number } = {},
) {
  const delay = options.delayMs ?? 600_000;
  if (!Number.isSafeInteger(delay) || delay < 1) throw Error("Invalid runtime idle delay.");
  const now = options.now ?? Date.now;
  let next = 0;
  let cursor: string | null = null;
  const pending = new Set<Promise<unknown>>();
  async function guard(tx: Sql, id: string) {
    const target = (
      await tx.query<{ task_prompt_id: string | null }>("select task_prompt_id from public.sandboxes where id=$1", [id])
    ).rows[0];
    if (!target?.task_prompt_id) throw Error("No settled task identity.");
    const busy = await tx.query(
      `select 1 from public.runtime_commands c join public.runtime_enrolments r
       on r.sandbox_id=c.sandbox_id and r.epoch=c.epoch
       where c.sandbox_id=$1 and c.result_enc is null limit 1`,
      [id],
    );
    if (busy.rows.length) throw Error("Runtime command pending.");
    const rows = (
      await tx.query<{ event_enc: Uint8Array<ArrayBuffer> }>(
        "select event_enc from public.runtime_events where sandbox_id=$1 order by sequence limit 10001",
        [id],
      )
    ).rows;
    if (rows.length > 10000) throw Error("Runtime history exceeds idle observation bound.");
    const events = await Promise.all(
      rows.map(async (row) => JSON.parse(await decryptSecret(row.event_enc, key)) as AgentEvent),
    );
    if (
      !events.some(
        (event) =>
          event.kind === "prompt" && event.promptId === target.task_prompt_id && isFinalPromptStatus(event.status),
      )
    )
      throw Error("Current turn has not settled.");
    if (!runtimeIdle(events, now(), delay)) throw Error("Runtime is not idle.");
  }
  return {
    async drain() {
      await Promise.allSettled([...pending]);
    },
    async reconcileOne(signal: AbortSignal) {
      if (now() < next || pending.size) return false;
      next = now() + 60_000;
      const work = (async () => {
        const rows = (
          await sql.query<{ id: string; owner_id: string; org_id: string; request_id: string | null }>(
            `select s.id,s.owner_id,s.org_id,p.request_id::text from public.sandboxes s
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           join public.runtime_enrolments r on r.sandbox_id=s.id
           left join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
           where (s.boat_runtime or (s.provider='modal' and s.runtime_transport='dialout'))
           and s.status in ('ready','running') and s.stop_requested_at is null
           and s.expires_at>now() and not s.application_secret_tainted
           and s.activity_lease_id is null and (s.reconcile_lease_until is null or s.reconcile_lease_until<now())
           order by case when $1::uuid is null or s.id>$1::uuid then 0 else 1 end,s.id limit 20`,
            [cursor],
          )
        ).rows;
        for (const row of rows) {
          signal.throwIfAborted();
          cursor = row.id;
          try {
            // Avoid creating an intent unless idle; the authoritative check repeats
            // under checkpoint's admission lock, closing the send/exec race.
            await guard(sql, row.id);
            const requestId = row.request_id ?? crypto.randomUUID();
            await checkpoint(
              { userId: row.owner_id, orgs: [{ orgId: row.org_id, role: "member" }], via: "service" },
              { id: row.id, request_id: requestId, runtimeVersion: 1 },
              (tx) => guard(tx, row.id),
            );
            signal.throwIfAborted();
            // Leave expiry unchanged. Existing lifecycle owns fenced provider shutdown.
            await sql.query(
              `update public.sandboxes set status='stopping',status_reason='idle_paused',stop_requested_at=coalesce(stop_requested_at,now()),
               stop_generation=stop_generation+1,reconcile_after=now()
               where id=$1 and status in ('ready','running') and stop_requested_at is null
               and exists(select 1 from public.runtime_checkpoints p join public.runtime_enrolments r
                 on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch where p.sandbox_id=$1 and p.request_id=$2::uuid and p.watermark is not null
                 and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1))`,
              [row.id, requestId],
            );
          } catch {
            // Pending checkpoints retain their request ID and retry next sweep.
          }
        }
      })();
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      let abort = () => {};
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      return false;
    },
  };
}
