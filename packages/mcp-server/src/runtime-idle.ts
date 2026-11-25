import { HARNESS_CAPABILITIES, type Harness } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";
import { isSandboxPlacementProvider, type Sql } from "@armada/core/server";
import { hostDrainingSql } from "./docker-host-drain.ts";
import { supportsDockerHostProtocol } from "./docker-host-version.ts";
import { mergedWorkProof } from "./merged-work.ts";
import { unresolvedModalLaunch } from "./modal-launch-handoff.ts";
import { usesHostLaunch } from "./provider-runtime-admission.ts";
import { dispatchableRuntimeCommand } from "./runtime-authority-extension.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { expiredOutputRead } from "./runtime-commands.ts";
import { projectRuntimeIdle } from "./runtime-idle-evidence.ts";
import { admitCheckpointedIdleStop, settleRuntimeTurn } from "./sandbox-lifecycle.ts";

/** The checkpoint transaction owns the sandbox row before rechecking idle. Its durable
 * intent fences sends before any RPC; uncertainty never dispatches a compute stop. */
export function createRuntimeIdle(
  sql: Sql,
  key: string,
  checkpoint: RuntimeCheckpoint,
  options: {
    delayMs?: number;
    now?: () => number;
    hasActiveRelay?: (sandboxId: string) => boolean;
    dockerStop?: (actor: { userId: string; orgId: string }, id: string, checkpointRequest: string) => Promise<unknown>;
  } = {},
) {
  const delay = options.delayMs ?? 600_000;
  if (!Number.isSafeInteger(delay) || delay < 1) throw Error("Invalid runtime idle delay.");
  const now = options.now ?? Date.now;
  let next = 0;
  let cursor: string | null = null;
  const pending = new Set<Promise<unknown>>();
  async function guard(tx: Sql, id: string, generation: string, requestId: string | null) {
    const target = (
      await tx.query<{
        provider: string;
        harness: Harness;
        task_prompt_id: string | null;
        merge_proof: boolean;
        request_id: string | null;
        merge_stop: boolean | null;
      }>(
        `select s.provider,s.harness,s.task_prompt_id,${mergedWorkProof("s")} as merge_proof,p.request_id::text,p.merge_stop
         from public.sandboxes s
         join public.runtime_enrolments r on r.sandbox_id=s.id
         left join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
         where s.id=$1 and s.lifecycle_generation=$2 and r.lifecycle_generation=s.lifecycle_generation`,
        [id, generation],
      )
    ).rows[0];
    if (!target?.task_prompt_id || target.request_id !== requestId) throw Error("Runtime checkpoint target changed.");
    // A committed checkpoint can leave the guest quiesced and mutations fenced.
    // The machine default controls fresh admission; the exact intent can still settle.
    const mergeStop = requestId === null ? target.merge_proof : target.merge_stop === true;
    if (
      requestId === null &&
      !mergeStop &&
      (!HARNESS_CAPABILITIES[target.harness].resume ||
        !isSandboxPlacementProvider(target.provider) ||
        !capabilities(target.provider).idleStop)
    )
      throw Error("Machine does not stop for inactivity.");
    const busy = await tx.query(
      `select 1 from public.runtime_commands c join public.runtime_enrolments r
       on r.sandbox_id=c.sandbox_id and r.epoch=c.epoch
       where c.sandbox_id=$1 and c.result_enc is null and not ${expiredOutputRead("c.request_id", "$2")}
         and ${dispatchableRuntimeCommand("c.sandbox_id", "c.epoch", "c.request_id")} limit 1`,
      [id, String(now())],
    );
    if (busy.rows.length) throw Error("Runtime command pending.");
    const evidence = (
      await tx.query<{ last_activity: number; eligible: boolean }>(
        `select e.last_activity,
         (not e.unknown_turn
          and e.sequence=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1)
          and exists(select 1 from public.runtime_idle_turns where sandbox_id=$1 and prompt_id=$2 and settled)
          and not exists(select 1 from public.runtime_idle_turns where sandbox_id=$1 and not settled)) as eligible
         from public.runtime_idle_evidence e where e.sandbox_id=$1`,
        [id, target.task_prompt_id],
      )
    ).rows[0];
    if (!evidence?.eligible || evidence.last_activity <= 0 || (!mergeStop && now() - evidence.last_activity < delay))
      throw Error("Runtime is not idle.");
    if (!mergeStop && options.hasActiveRelay?.(id)) throw Error("Runtime relay is active.");
    return mergeStop;
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
          await sql.query<{
            id: string;
            owner_id: string;
            org_id: string;
            provider: string;
            daemon_protocol: number | null;
            request_id: string | null;
          }>(
            `select s.id,s.owner_id,s.org_id,s.provider::text,h.daemon_protocol,p.request_id::text from public.sandboxes s
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           join public.runtime_enrolments r on r.sandbox_id=s.id
           left join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch
           left join public.docker_hosts h on h.id=s.docker_host_id and h.installation_id=s.docker_installation_id
             and h.hash is not null and h.revoked_at is null and h.registration_hash is null and not ${hostDrainingSql("h")}
             and exists(select 1 from public.members hm where hm.org_id=h.org_id and hm.user_id=h.owner_id)
           where (s.boat_runtime or (s.provider='modal' and s.runtime_transport='dialout') or (s.provider='docker' and $2::boolean))
           and s.status in ('ready','running') and s.stop_requested_at is null
           and not ${unresolvedModalLaunch("s")}
           and not exists(select 1 from public.jobs j where j.sandbox_id=s.id
             and j.generation=s.lifecycle_generation and j.kind='stop' and j.state in ('queued','leased'))
           and s.expires_at>now() and not s.application_secret_tainted
           and s.activity_lease_id is null and (s.reconcile_lease_until is null or s.reconcile_lease_until<now())
           order by case when $1::uuid is null or s.id>$1::uuid then 0 else 1 end,s.id limit 20`,
            [cursor, options.dockerStop !== undefined],
          )
        ).rows;
        for (const row of rows) {
          signal.throwIfAborted();
          cursor = row.id;
          if (options.hasActiveRelay?.(row.id)) continue;
          if (usesHostLaunch(row.provider) && !supportsDockerHostProtocol(row.daemon_protocol)) continue;
          try {
            // Avoid creating an intent unless idle; the authoritative check repeats
            // under checkpoint's admission lock, closing the send/exec race.
            // Upgrade pre-projection archives once, outside checkpoint admission.
            // Lock in the same order as ingestion so no committed events are lost.
            const generation = await sql.transaction!(async (tx) => {
              const locked = await tx.query<{ generation: string }>(
                "select lifecycle_generation::text as generation from public.sandboxes where id=$1 for update",
                [row.id],
              );
              const legacy = (
                await tx.query<{ sequence: string }>(
                  `select coalesce(max(sequence),0)::text as sequence from public.runtime_events
                   where sandbox_id=$1 and not exists
                     (select 1 from public.runtime_idle_evidence where sandbox_id=$1)`,
                  [row.id],
                )
              ).rows[0];
              if (Number(legacy?.sequence) > 0)
                await projectRuntimeIdle(tx, row.id, key, Number(legacy!.sequence), [], Number(legacy!.sequence));
              const generation = locked.rows[0]?.generation;
              if (generation !== undefined) await settleRuntimeTurn(tx, row.id, generation, key);
              return generation;
            });
            if (generation === undefined) continue;
            // A legacy/manual checkpoint has no merge-stop intent. It still
            // must pass the ordinary idle timer before this worker can stop it.
            await guard(sql, row.id, generation, row.request_id);
            const requestId = row.request_id ?? crypto.randomUUID();
            await checkpoint(
              { userId: row.owner_id, orgs: [{ orgId: row.org_id, role: "member" }], via: "service" },
              { id: row.id, request_id: requestId, runtimeVersion: 1 },
              (tx) => guard(tx, row.id, generation, row.request_id),
            );
            signal.throwIfAborted();
            if (usesHostLaunch(row.provider)) {
              // Host store rechecks checkpoint identity under its own ordered locks
              // before recording the durable intent.
              await options.dockerStop?.({ userId: row.owner_id, orgId: row.org_id }, row.id, requestId);
              continue;
            }
            await sql.transaction!((tx) => admitCheckpointedIdleStop(tx, row.id, generation, requestId));
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
