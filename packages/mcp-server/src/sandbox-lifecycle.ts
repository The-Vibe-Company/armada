import {
  HOST_CAPABILITIES,
  isFinalPromptStatus,
  isSandboxProvider,
  type Provider,
  ProviderError,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { mergedWorkProof } from "./merged-work.ts";

import { nativeIdleDue, nativeQuiescent } from "./native-idle.ts";
import { INTERRUPTED_LAUNCH_REASON } from "./turns.ts";
import { preserveBeforeStop, recordStopDispatch } from "./work-preservation.ts";

export const UNENROLLED_RESUME_STOP = "runtime_resume_unenrolled";
const OPERATOR_CLEANUP_PREFIX = "Operator cleanup required:";

export async function requestFailedRuntimeResumeStop(
  tx: Sql,
  sandboxId: string,
  requestId: string,
  generation: number | undefined,
  retained: boolean,
) {
  const changed = await tx.query<{ status: "stopping" | "failed" }>(
    `update public.sandboxes set
    status=case when $4 and not application_secret_tainted then 'stopping'::public.sandbox_status else 'failed'::public.sandbox_status end,
    transition_context=jsonb_build_object('actor','runtime_resume','code',
      case when $4 and not application_secret_tainted then $5::text else 'restore_unconfirmed' end),
    status_reason=case when $4 and not application_secret_tainted then null
      else 'Runtime resume failed before a restored worker was confirmed; cleanup requested.' end,
    stop_requested_at=now(),stop_generation=stop_generation+1,
    activity_lease_id=null,activity_until=null,lifecycle_generation=lifecycle_generation+1,
    reconcile_after=case when $4 and not application_secret_tainted then 'infinity'::timestamptz else now() end
    where id=$1 and status='starting' and activity_lease_id=$2 and lifecycle_generation=$3
      and stop_requested_at is null and deleted_at is null
      and (reconcile_lease_until is null or reconcile_lease_until<now()) returning status`,
    [sandboxId, requestId, generation, retained, UNENROLLED_RESUME_STOP],
  );
  return changed.rows[0]?.status;
}

/** One bounded batch in the existing server loop. SQL leases serialize replicas; generation
 * fencing prevents an old observation from publishing over a newly admitted resume. */
export function createSandboxLifecycle(
  sql: Sql,
  providerFor: (id: string) => Promise<Provider>,
  options: { now?: () => number; delayMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const delay = options.delayMs ?? 600_000;
  if (!Number.isSafeInteger(delay) || delay < 1) throw Error("Invalid native idle delay.");
  const pending = new Set<Promise<unknown>>();
  // Four slots per authority (eight total). Reserve before SQL so concurrent
  // callers cannot over-admit; keep a reservation until every raw SDK call settles.
  const authorities = ["boat", "modal"] as const;
  const admitted = { boat: 0, modal: 0 };
  let next = 0;
  async function reconcile(providerId: "boat" | "modal", signal?: AbortSignal): Promise<boolean> {
    const raw = new Set<Promise<unknown>>();
    async function operation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      const running = work();
      raw.add(running);
      pending.add(running);
      const settled = running.finally(() => {
        raw.delete(running);
        pending.delete(running);
      });
      if (!signal) return settled;
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    }
    try {
      const token = crypto.randomUUID();
      const row = (
        await sql.query<{
          id: string;
          provider_sandbox_id: string;
          boat_runtime: boolean;
          runtime_transport: string | null;
          lifecycle_generation: number;
          expires_at: Date | string;
          status: string;
          status_reason: string | null;
          task_prompt_id: string | null;
          activity_lease_id: string | null;
          application_secret_tainted: boolean;
          credential_id: string | null;
          credential_version: number | null;
          owner_is_member: boolean;
          retained_resume: boolean;
          work_merged: boolean | null;
          preservation_note: string | null;
          stop_requested_at: Date | string | null;
        }>(
          `update public.sandboxes s set reconcile_lease=$1::uuid,
          reconcile_lease_until=now()+interval '2 minutes'
        from (
          select candidate.id,recovery.retained_resume from public.sandboxes candidate
          cross join lateral (select candidate.provider='boat' and candidate.status='stopping' and exists(
            select 1 from public.sandbox_transitions t where t.sandbox_id=candidate.id and t.generation=candidate.lifecycle_generation
            and t.actor='runtime_resume' and t.code=$3 and t.to_status='stopping'
          ) as retained_resume) recovery
          where candidate.provider = $2 and candidate.status not in ('stopped','deleted')
          and not exists(select 1 from public.orchestrators parent where parent.sandbox_id=candidate.id)
          and not (candidate.status='failed' and candidate.stopped_at is not null)
          -- Only this worker understands the retained-resume handoff. Old
          -- replicas see an infinite schedule and cannot claim it.
          and (candidate.reconcile_after<=now()
            or (recovery.retained_resume and coalesce(candidate.lifecycle_error,'') not like $4))
          and (candidate.activity_until is null or candidate.activity_until<now())
          and (candidate.reconcile_lease_until is null or candidate.reconcile_lease_until<now())
          order by case when recovery.retained_resume
            then coalesce(candidate.reconcile_lease_until,candidate.stop_requested_at)
            else candidate.reconcile_after end
          limit 1 for update of candidate skip locked
        ) due
        where s.id=due.id
        returning s.id,s.provider_sandbox_id,s.runtime_transport,s.boat_runtime,s.lifecycle_generation,s.expires_at,s.status::text as status,s.status_reason,s.task_prompt_id,s.activity_lease_id,s.application_secret_tainted,s.credential_id,s.credential_version,s.stop_requested_at,s.preservation_note,
          ${mergedWorkProof("s")} as work_merged,due.retained_resume,
          exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) as owner_is_member`,
          [token, providerId, UNENROLLED_RESUME_STOP, `${OPERATOR_CLEANUP_PREFIX}%`],
        )
      ).rows[0];
      if (!row) return false;
      // Only an already-requested stop may enter operator custody. This is not
      // provider authority: the worker never substitutes credentials or allocates.
      const operatorStop = row.status === "stopping" && row.stop_requested_at !== null;
      const deferToOperator = async (reason: string) => {
        await sql.query(
          `update public.sandboxes set lifecycle_error=$4,
            reconcile_after='infinity'::timestamptz,reconcile_lease=null,reconcile_lease_until=null
          where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
            and status='stopping' and stop_requested_at is not null
            and reconcile_lease_until>clock_timestamp()
            and (activity_until is null or activity_until<now())`,
          [
            row.id,
            token,
            row.lifecycle_generation,
            `${OPERATOR_CLEANUP_PREFIX} ${reason} Physical outcome unknown; retained identity unchanged. Follow docs/stopping-authority-loss.md.`,
          ],
        );
      };
      if (!row.owner_is_member) {
        if (operatorStop) {
          await deferToOperator("owner membership removed.");
          return true;
        }
        // Missing membership grants no worker management authority. Report the orphan
        // without resolving credentials, observing the machine or changing its status.
        await sql.query(
          `update public.sandboxes set
            lifecycle_error='Cleanup blocked: removed-owner authority is unavailable. Automatic cleanup requires service-owned worker authority.',
            reconcile_after=now()+interval '1 minute',reconcile_lease=null,reconcile_lease_until=null
          where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
            and reconcile_lease_until>now() and (activity_until is null or activity_until<now())`,
          [row.id, token, row.lifecycle_generation],
        );
        return true;
      }
      let terminal = false;
      let physicalExit = false;
      let error: string | null = null;
      let resolved = false;
      let stoppedAt: Date | undefined;
      const expired = new Date(row.expires_at).getTime() <= now();
      const retainedResume = row.retained_resume;
      const native = !row.boat_runtime && row.runtime_transport !== "dialout";
      // Lease expiry is not evidence a native exec completed. Retain its identity
      // until an owner outcome or explicit/TTL cleanup, rather than inventing idle.
      const retainUnknownActivity =
        native &&
        row.activity_lease_id !== null &&
        !expired &&
        !row.stop_requested_at &&
        ["ready", "running"].includes(row.status);
      try {
        // Uses persisted owner membership, source credential visibility and pinned Modal App.
        const provider = await operation(signal, () => providerFor(row.id));
        resolved = true;
        let info = await operation(signal, () => provider.get(row.provider_sandbox_id));
        // Name the persisted selection and provider observation before any capture.
        // No secret values or provider error bodies enter this diagnostic.
        try {
          console.info(
            JSON.stringify({
              event: "sandbox_lifecycle_observation",
              sandboxId: row.id,
              providerSandboxId: row.provider_sandbox_id,
              provider: providerId,
              status: row.status,
              statusReason:
                row.status_reason === null
                  ? null
                  : ["idle_paused", "expired", "agent_finished", "work_merged"].includes(row.status_reason)
                    ? row.status_reason
                    : "other",
              expired,
              stopRequested: row.stop_requested_at !== null,
              normalizedState: info.state,
              terminal: info.physicalExitConfirmed === true || ["stopped", "deleted"].includes(info.state),
            }),
          );
        } catch {
          /* Diagnostics cannot change lifecycle settlement. */
        }
        const host = isSandboxProvider(provider.id) ? HOST_CAPABILITIES[provider.id] : undefined;
        physicalExit = info.physicalExitConfirmed === true;
        // A native turn's terminal receipt frees model capacity immediately on observation,
        // independently of the later machine-idle timer. Never let a stale receipt settle
        // a new task or an uncertain activity lease.
        if (
          native &&
          row.task_prompt_id &&
          !row.activity_lease_id &&
          !row.stop_requested_at &&
          ["ready", "running"].includes(row.status) &&
          ["ready", "running"].includes(info.state)
        ) {
          const turn = await operation(signal, () =>
            provider.getPrompt({
              sandboxId: row.provider_sandbox_id,
              promptId: row.task_prompt_id!,
              ...(signal ? { signal } : {}),
            }),
          );
          if (turn.promptId === row.task_prompt_id && turn.done && isFinalPromptStatus(turn.status)) {
            await sql.query(
              `select public.enqueue_webhook_turn(id,task_prompt_id,$5) from public.sandboxes
               where id=$1 and reconcile_lease=$2::uuid and lifecycle_generation=$3
                 and reconcile_lease_until>now() and activity_lease_id is null
                 and task_prompt_id=$4 and stop_requested_at is null
                 and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)`,
              [row.id, token, row.lifecycle_generation, row.task_prompt_id, turn.status],
            );
            await sql.query(
              `insert into public.runtime_idle_turns(sandbox_id,prompt_id,settled)
               select id,task_prompt_id,true from public.sandboxes
               where id=$1 and reconcile_lease=$2::uuid and lifecycle_generation=$3
                 and reconcile_lease_until>now() and activity_lease_id is null
                 and task_prompt_id=$4 and stop_requested_at is null
                 and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id)
               on conflict(sandbox_id,prompt_id) do update set settled=true`,
              [row.id, token, row.lifecycle_generation, row.task_prompt_id],
            );
          }
        }
        const workMerged = row.work_merged === true && !row.stop_requested_at;
        const idleStop =
          native &&
          !expired &&
          (["idle_paused", "work_merged"].includes(row.status_reason ?? "") ||
            (!row.stop_requested_at &&
              row.activity_lease_id === null &&
              !row.application_secret_tainted &&
              row.credential_id !== null &&
              row.credential_version !== null &&
              ["ready", "running"].includes(row.status) &&
              (await operation(signal, () =>
                nativeIdleDue(provider, info, row.task_prompt_id, now(), workMerged ? 0 : delay, signal),
              ))));
        if (
          !physicalExit &&
          !["stopped", "deleted"].includes(info.state) &&
          !(host?.waitForPendingStop && info.state === "stopping") &&
          (row.stop_requested_at !== null ||
            row.status === "stopping" ||
            row.status === "starting" ||
            expired ||
            idleStop)
        ) {
          signal?.throwIfAborted();
          const owned = await sql.query<{ id: string }>(
            `update public.sandboxes
            set reconcile_lease_until=now()+interval '2 minutes',
              stop_requested_at=coalesce(stop_requested_at,clock_timestamp()),
              stop_generation=case when stop_requested_at is null then stop_generation+1 else stop_generation end,
              status=case when status in ('starting','failed') then status else 'stopping'::public.sandbox_status end,
              transition_context=jsonb_build_object('actor','reconciler','code',
                case when $4 and status_reason is distinct from 'work_merged' then 'expired'
                  when $5 and ($6 or status_reason='work_merged') then 'work_merged'
                  when $5 then 'idle_paused' else 'stop_requested' end),
              status_reason=case when $4 and status not in ('starting','failed') and status_reason is distinct from 'work_merged' then 'expired' when $5 then case when $6 or status_reason='work_merged' then 'work_merged' else 'idle_paused' end else status_reason end
            where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
              and reconcile_lease_until>now() and (activity_until is null or activity_until<now())
              and (not $6 or (activity_lease_id is null and stop_requested_at is null and expires_at>now()
                and ${mergedWorkProof("sandboxes")}))
              and exists(select 1 from public.members m where m.org_id=sandboxes.org_id and m.user_id=sandboxes.owner_id) returning id`,
            [row.id, token, row.lifecycle_generation, expired, idleStop, workMerged && idleStop],
          );
          if (!owned.rows[0]) return true;
          signal?.throwIfAborted();
          // These durable phases already fence native admission. Active-only
          // observation or recapture would prevent the owning reconciler from retrying.
          const reconcilingStop =
            idleStop && info.state === "stopping" && host?.fencedStopPhases.includes(info.providerState) === true;
          const requireIdle = async () => {
            if (!(await nativeQuiescent(provider, info, signal)))
              throw new ProviderError({
                provider: provider.id,
                code: "sandbox_not_ready",
                retryable: true,
                message: "Native work is active or unknown; idle stop waits without interruption.",
              });
          };
          if (idleStop && !reconcilingStop) await operation(signal, requireIdle);
          const preservationProvider = idleStop
            ? new Proxy(provider, {
                get(target, property) {
                  if (property === "quiesce") return requireIdle;
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              })
            : provider;
          // Automatic idle stop may observe quiescence, never interrupt a turn.
          if (
            !idleStop &&
            !row.boat_runtime &&
            row.runtime_transport !== "dialout" &&
            ["ready", "running"].includes(info.state)
          )
            await operation(signal, () =>
              (provider.quiesce ?? provider.interrupt).call(provider, { sandboxId: row.provider_sandbox_id }),
            );
          signal?.throwIfAborted();
          if (
            !reconcilingStop &&
            (await preserveBeforeStop(
              sql,
              preservationProvider,
              row.id,
              row.provider_sandbox_id,
              "lifecycle_stop",
            ).catch(() => {})) === "pending"
          )
            throw new ProviderError({
              provider: provider.id,
              code: "sandbox_not_ready",
              retryable: true,
              message: "Interruption is pending; retry stop after turns settle.",
            });
          signal?.throwIfAborted();
          if (idleStop && !reconcilingStop) await operation(signal, requireIdle);
          const requireRetention =
            !expired &&
            (retainedResume || idleStop || ["idle_paused", "work_merged"].includes(row.status_reason ?? ""));
          recordStopDispatch(row.id, row.provider_sandbox_id, "lifecycle_stop");
          await operation(signal, () =>
            provider.stop({
              sandboxId: row.provider_sandbox_id,
              ...(requireRetention ? { requireRetention: true } : {}),
            }),
          );
          info = await operation(signal, () => provider.get(row.provider_sandbox_id));
        }
        signal?.throwIfAborted();
        physicalExit = info.physicalExitConfirmed === true || info.stopNote === "checkpoint_failed_disk_not_retained";
        stoppedAt = info.stoppedAt;
        terminal = physicalExit || ["stopped", "deleted"].includes(info.state);
        if (!terminal && (expired || row.status === "stopping" || row.stop_requested_at !== null))
          error = "Provider stop is not yet confirmed. Retrying without deleting retained data.";
      } catch (caught) {
        const authorityLost =
          (caught instanceof VaultError &&
            ["missing_credential", "forbidden", "not_found", "credential_refused"].includes(caught.code)) ||
          (caught instanceof ProviderError && ["unauthorized", "forbidden"].includes(caught.code));
        if (authorityLost && operatorStop && !signal?.aborted) {
          await deferToOperator("original provider authority unavailable.");
          return true;
        }
        // A definitive absence for the exact registered identity is terminal.
        // Never infer absence from transport errors or discover resources by name.
        if (resolved && caught instanceof ProviderError && caught.code === "not_found") {
          terminal = true;
          if (retainedResume) physicalExit = true;
        }
        // No provider exception text: SDK errors may contain credential-bearing requests.
        else error = "Provider lifecycle observation unavailable. Retrying without deleting retained data.";
      }
      await sql.query(
        `update public.sandboxes set
        -- A failed launch keeps its diagnostic even after its machine is confirmed stopped.
        status=case when $7 or status='starting' then 'failed'::public.sandbox_status when $4 and status <> 'failed' then 'stopped'::public.sandbox_status else status end,
        transition_context=jsonb_build_object('actor','reconciler','code',
          case when status='starting' then 'launch_interrupted'
            when $7 then 'provider_exit_without_checkpoint'
            when $10 and status_reason is distinct from 'work_merged' then 'expired'
            else 'provider_stopped' end),
        status_reason=case when status='starting' then coalesce(status_reason,$8::text) when $7 then coalesce(case when status_reason not in ('idle_paused','work_merged') then status_reason end,'Provider confirmed physical exit without a new verified recovery checkpoint.') when $4 and $10 and status<>'failed' and status_reason is distinct from 'work_merged' then 'expired' else status_reason end,
        stop_requested_at=case when $4 then null when status='starting' then coalesce(stop_requested_at,now()) else stop_requested_at end,
        stopped_at=case when $4 then coalesce(stopped_at,$9::timestamptz,now()) else stopped_at end,
        last_observed_at=case when $5::text is null then now() else last_observed_at end,
        activity_lease_id=case when $11 and not $4 then activity_lease_id else null end,
        activity_until=case when $11 and not $4 then activity_until else null end,
        lifecycle_error=$5::text,
        reconcile_after=case when $12 and not $4 then 'infinity'::timestamptz else now()+interval '1 minute' end,
        reconcile_lease=case when $6 then reconcile_lease else null end,
        reconcile_lease_until=case when $6 then reconcile_lease_until
          when $12 and not $4 then now()+interval '1 minute' else null end
        where id=$1::uuid and reconcile_lease=$2::uuid and lifecycle_generation=$3
          and reconcile_lease_until>clock_timestamp()
          and (activity_until is null or activity_until<now())`,
        [
          row.id,
          token,
          row.lifecycle_generation,
          terminal,
          error,
          signal?.aborted ?? false,
          physicalExit,
          INTERRUPTED_LAUNCH_REASON,
          stoppedAt?.toISOString() ?? null,
          expired,
          retainUnknownActivity,
          retainedResume,
        ],
      );
      return true;
    } finally {
      if (raw.size === 0) admitted[providerId]--;
      else
        void Promise.allSettled([...raw]).then(() => {
          admitted[providerId]--;
        });
    }
  }
  return {
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const first = next;
      next = (next + 1) % authorities.length;
      for (let offset = 0; offset < authorities.length; offset++) {
        const providerId = authorities[(first + offset) % authorities.length]!;
        if (admitted[providerId] >= 4) continue;
        admitted[providerId]++;
        if (await reconcile(providerId, signal)) return true;
        signal?.throwIfAborted();
      }
      return false;
    },
  };
}
