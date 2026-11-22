import type { ApplicationVaultActor } from "./application-vault.ts";
import type { Sql } from "./golden-store.ts";
import { advanceRoutineSchedule, parseRoutineSchedule } from "./routine-schedule.ts";
import { routineLaunchRefusal } from "./routines.ts";
import { VaultError } from "./vault-error.ts";

export interface RoutineLaunchAdmission {
  /** Called by the template launch immediately before provider allocation, after the claim is durable. */
  beforeFork(tx?: Sql): Promise<void>;
  /** Cooperative cancellation; raw effects remain owned until settlement. */
  signal?: AbortSignal;
}

export type RoutineTaskState = "running" | "finished" | "failed" | "interrupted" | "unknown";

export interface RoutineSchedulerRuntime {
  /** Observe only the original prompt, never the latest conversation turn. */
  observe(
    actor: ApplicationVaultActor,
    prompt: { sandboxId: string; promptId: string; conversationId?: string },
    signal?: AbortSignal,
  ): Promise<RoutineTaskState>;
  /** The ordinary template path; actor is always the persisted execution owner. */
  launch(
    actor: ApplicationVaultActor,
    input: Record<string, unknown>,
    admission: RoutineLaunchAdmission,
  ): Promise<Record<string, unknown>>;
}
type Routine = {
  id: string;
  org_id: string;
  owner_id: string;
  scope: string;
  version: number;
  template_id: string;
  template_revision: number;
  prompt: string;
  ttl_seconds: number;
  interval_hours: number | null;
  cron: string | null;
  timezone: string;
  db_now: string | Date;
  max_runs_per_day: number;
  next_due_at: string | Date;
};
type Run = {
  id: string;
  routine_id: string;
  org_id: string;
  owner_id: string;
  request_key: string;
  state: string;
  lease_id: string | null;
};
type Claim = {
  reason?: string | null;
  id: string;
  state: string;
  sandbox_id: string | null;
  prompt_id: string | null;
  conversation_id: string | null;
};

/** A committed occurrence precedes dispatch. Leases bound work; template launch claims,
 * not lease expiry, prevent duplicate provider allocations across crashes and replicas. */
export function createRoutineScheduler(sql: Sql, runtime: RoutineSchedulerRuntime) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw Error("Routine scheduler transactions unavailable.");
    return sql.transaction(work);
  }
  async function settle(
    run: Run,
    state: "succeeded" | "failed" | "reconciling",
    claim?: Claim,
    reason?: string,
    refusal?: string | null,
  ) {
    await transaction(async (tx) => {
      await tx.query("select id from public.routines where id=$1 for update", [run.routine_id]);
      const changed = await tx.query(
        `update public.routine_runs set state=$3,reason=$4,template_request_id=$5,sandbox_id=$6,
         prompt_id=$7,conversation_id=$8,launch_refusal=$9,
         task_state=case when $3='succeeded' then case when $7::text is null then 'unknown' else 'running' end else null end,
         task_checked_at=case when $3='succeeded' then now() else null end,
         lease_id=null,lease_until=case when $3='reconciling' then now()+interval '1 minute' else null end,updated_at=now()
         where id=$1 and lease_id=$2 returning id`,
        [
          run.id,
          run.lease_id,
          state,
          reason ?? null,
          claim?.id ?? null,
          claim?.sandbox_id ?? null,
          claim?.prompt_id ?? null,
          claim?.conversation_id ?? null,
          routineLaunchRefusal(refusal),
        ],
      );
      if (!changed.rows.length || state === "reconciling") return;
      if (state === "succeeded") {
        await tx.query("update public.routines set consecutive_failures=0 where id=$1", [run.routine_id]);
      } else {
        await tx.query(
          `update public.routines set consecutive_failures=consecutive_failures+1,
          status=case when status='enabled' and consecutive_failures>=2 then 'paused' else status end,
          pause_reason=case when status='enabled' and consecutive_failures>=2 then 'repeated_launch_failures' else pause_reason end,
          next_due_at=case when status='enabled' and consecutive_failures>=2 then null else next_due_at end,
          version=version+case when status='enabled' and consecutive_failures>=2 then 1 else 0 end,updated_at=now()
          where id=$1`,
          [run.routine_id],
        );
      }
    });
  }
  async function templateClaim(run: Run): Promise<Claim | undefined> {
    return (
      await sql.query<Claim>(
        `select c.id,c.state,c.reason,case when c.state='failed' then s.id else c.sandbox_id end as sandbox_id,
         c.result->>'promptId' as prompt_id,c.result->>'conversationId' as conversation_id
         from public.template_launch_requests c
         left join public.sandboxes s on c.state='failed' and s.id=c.sandbox_id and s.org_id=c.org_id and s.owner_id=c.actor_id
         where c.org_id=$1 and c.actor_id=$2 and c.client_key=$3`,
        [run.org_id, run.owner_id, run.request_key],
      )
    ).rows[0];
  }
  async function reconcile(run: Run, claim: Claim) {
    if (claim.state === "succeeded") return settle(run, "succeeded", claim);
    if (claim.state === "failed") return settle(run, "failed", claim, "launch_failed", claim.reason);
    // A nonterminal template call may still publish/start after an observed stop. Only its
    // own terminal claim can resolve uncertainty; a sandbox status alone cannot fence it.
    return settle(run, "reconciling", claim, "launch_uncertain");
  }
  async function dispatch(run: Run, signal: AbortSignal) {
    const existing = await templateClaim(run);
    if (existing) return reconcile(run, existing);
    if (run.state === "reconciling") return settle(run, "reconciling", undefined, "launch_uncertain");
    const input = (
      await sql.query<{ template_id: string; template_revision: number; prompt: string; ttl_seconds: number }>(
        "select * from public.routine_run_inputs where run_id=$1",
        [run.id],
      )
    ).rows[0];
    if (!input) return settle(run, "failed", undefined, "launch_failed");
    const member = (
      await sql.query<{ role: string; scope: string }>(
        `select m.role,r.scope from public.members m join public.routines r on r.org_id=m.org_id
       where r.id=$1 and m.user_id=$2`,
        [run.routine_id, run.owner_id],
      )
    ).rows[0];
    if (!member || (member.scope === "org" && member.role !== "admin"))
      return settle(run, "failed", undefined, "owner_authorization_changed");
    try {
      const result = await runtime.launch(
        { userId: run.owner_id, orgs: [{ orgId: run.org_id }] },
        {
          org: run.org_id,
          id: input.template_id,
          revision: input.template_revision,
          prompt: input.prompt,
          ttlSeconds: input.ttl_seconds,
          requestKey: run.request_key,
        },
        {
          signal,
          beforeFork: async (tx = sql) => {
            signal.throwIfAborted();
            // A preflight can outlive its lease while another replica concludes that no claim
            // exists. Fence that stale caller at the provider boundary, not just history publication.
            const current = await tx.query(
              "select id from public.routine_runs where id=$1 and state='admitted' and lease_id=$2",
              [run.id, run.lease_id],
            );
            if (!current.rows.length) throw Error("Routine launch admission expired.");
          },
        },
      );
      const claim = await templateClaim(run);
      if (claim) return reconcile(run, claim);
      if (result.state === "failed")
        return settle(run, "failed", undefined, "launch_failed", routineLaunchRefusal(result.reason));
    } catch (error) {
      const claim = await templateClaim(run);
      if (claim) return reconcile(run, claim);
      return settle(
        run,
        signal.aborted ? "reconciling" : "failed",
        undefined,
        signal.aborted ? "launch_uncertain" : "launch_failed",
        !signal.aborted && error instanceof VaultError
          ? (routineLaunchRefusal(/^Template launch refused: ([a-z_]+)\.$/.exec(error.message)?.[1]) ??
              routineLaunchRefusal(error.code))
          : null,
      );
    }
    const claim = await templateClaim(run);
    // A normal template launch leaves its durable claim. Do not treat unexplained absence as
    // permission to allocate another key; retain a visible uncertain occurrence.
    if (!claim) return settle(run, "reconciling", undefined, "launch_uncertain");
    return reconcile(run, claim);
  }
  async function leaseRecovery(provider: string): Promise<Run | undefined> {
    return transaction(async (tx) => {
      const run = (
        await tx.query<Run>(
          `select * from public.routine_runs where state in ('admitted','reconciling')
         and (lease_until is null or lease_until<=now()) and not (id=any($2::uuid[]))
         and exists (select 1 from public.routine_run_inputs i
          join public.launch_template_revisions v on v.template_id=i.template_id and v.revision=i.template_revision
          where i.run_id=routine_runs.id and coalesce(v.definition->>'provider','unknown')=$1)
         order by lease_until nulls first,created_at,id for update skip locked limit 1`,
          [provider, [...dispatches]],
        )
      ).rows[0];
      if (!run) return;
      return (
        await tx.query<Run>(
          "update public.routine_runs set lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' where id=$1 returning *",
          [run.id],
        )
      ).rows[0];
    });
  }
  async function admit(provider: string): Promise<Run | undefined | null> {
    return transaction(async (tx) => {
      const routine = (
        await tx.query<Routine>(
          `select *,now() as db_now from public.routines where status='enabled' and next_due_at<=now()
           and exists (select 1 from public.launch_template_revisions v where v.template_id=routines.template_id
            and v.revision=routines.template_revision and coalesce(v.definition->>'provider','unknown')=$1)
           order by next_due_at,id for update skip locked limit 1`,
          [provider],
        )
      ).rows[0];
      if (!routine) return null;
      const previous = (
        await tx.query<{ state: string; sandbox_id: string | null; status: string | null; deleted_at: string | null }>(
          `select rr.state,rr.sandbox_id,s.status,s.deleted_at from public.routine_runs rr
         left join public.sandboxes s on s.id=rr.sandbox_id
         left join public.template_launch_requests claim on claim.id=rr.template_request_id
          and claim.org_id=rr.org_id and claim.actor_id=rr.owner_id and claim.client_key=rr.request_key
         where rr.routine_id=$1 and (
          rr.state in ('admitted','reconciling') or
          ((rr.sandbox_id is not null or rr.state='succeeded') and
           ((s.id is null and (rr.state<>'failed' or claim.state is distinct from 'failed')) or
            (s.status not in ('stopped','deleted') and not (s.status='failed' and s.stopped_at is not null) and s.deleted_at is null))))
         order by case when rr.state in ('admitted','reconciling') or s.id is null then 0 else 1 end limit 1`,
          [routine.id],
        )
      ).rows[0];
      let nextDueAt: Date | null = null,
        missed = 0,
        capped = false,
        scheduleInvalid = false;
      try {
        const now = new Date(routine.db_now),
          due = new Date(routine.next_due_at);
        if (routine.cron) {
          const advanced = advanceRoutineSchedule(parseRoutineSchedule(routine.cron, routine.timezone), due, now);
          nextDueAt = advanced.nextDueAt;
          missed = advanced.missedOccurrences;
          capped = advanced.missedCountCapped;
        } else {
          const period = routine.interval_hours! * 3600000;
          const count = Math.floor((now.getTime() - due.getTime()) / period);
          if (!Number.isFinite(count) || count < 0) throw new VaultError("invalid", "Invalid legacy schedule.");
          missed = Math.min(count, 1000);
          capped = count >= 1000;
          nextDueAt = new Date(due.getTime() + (count + 1) * period);
        }
      } catch (error) {
        if (!(error instanceof VaultError) || error.code !== "invalid") throw error;
        scheduleInvalid = true;
      }
      let reason: string | null = null;
      if (previous)
        reason =
          ["admitted", "reconciling"].includes(previous.state) || !previous.status
            ? "previous_run_uncertain"
            : "previous_run_alive";
      const count = (
        await tx.query<{ count: number }>(
          "select count(*)::int as count from public.routine_runs where routine_id=$1 and state!='skipped' and created_at>now()-interval '24 hours'",
          [routine.id],
        )
      ).rows[0]?.count;
      if (!reason && (count ?? 0) >= routine.max_runs_per_day) reason = "daily_limit_reached";
      if (scheduleInvalid) reason = "schedule_unavailable";
      const run = (
        await tx.query<Run>(
          `insert into public.routine_runs(routine_id,org_id,owner_id,scheduled_due_at,configuration_version,state,reason,request_key,missed_intervals,missed_count_capped,lease_id,lease_until)
         values($1,$2,$3,$4,$5,$6,$7,'routine:'||gen_random_uuid()::text,
          $8,$9,
          case when $6='admitted' then gen_random_uuid() else null end,
          case when $6='admitted' then now()+interval '5 minutes' else null end) returning *`,
          [
            routine.id,
            routine.org_id,
            routine.owner_id,
            routine.next_due_at,
            routine.version,
            reason ? "skipped" : "admitted",
            reason,
            missed,
            capped,
          ],
        )
      ).rows[0]!;
      await tx.query(
        `update public.routines set next_due_at=$2,
        status=case when $3 then 'paused' else status end,
        pause_reason=case when $3 then 'schedule_unavailable' else pause_reason end,
        version=version+case when $3 then 1 else 0 end,
        updated_at=case when $3 then now() else updated_at end where id=$1`,
        [routine.id, nextDueAt, scheduleInvalid],
      );
      if (reason) return undefined;
      await tx.query(
        "insert into public.routine_run_inputs(run_id,template_id,template_revision,prompt,ttl_seconds) values($1,$2,$3,$4,$5)",
        [run.id, routine.template_id, routine.template_revision, routine.prompt, routine.ttl_seconds],
      );
      return run;
    });
  }
  async function observeTask(provider: string, signal: AbortSignal): Promise<boolean> {
    const task = await transaction(async (tx) => {
      const candidate = (
        await tx.query<{
          id: string;
          org_id: string;
          owner_id: string;
          sandbox_id: string | null;
          prompt_id: string | null;
          conversation_id: string | null;
          task_check_id: string;
        }>(
          `select * from public.routine_runs where state='succeeded' and task_state in ('running','unknown')
          and (task_checked_at is null or task_checked_at<=now()-interval '1 minute')
          and coalesce((select s.provider::text from public.sandboxes s where s.id=routine_runs.sandbox_id),'unknown')=$1
          order by task_checked_at nulls first,id for update skip locked limit 1`,
          [provider],
        )
      ).rows[0];
      if (!candidate) return;
      return (
        await tx.query<typeof candidate>(
          "update public.routine_runs set task_checked_at=now(),task_check_id=gen_random_uuid() where id=$1 returning *",
          [candidate.id],
        )
      ).rows[0];
    });
    if (!task) return false;
    let state: RoutineTaskState = "unknown";
    const member = (
      await sql.query<{ role: string; scope: string }>(
        `select m.role,r.scope from public.members m join public.routines r on r.org_id=m.org_id
       join public.routine_runs rr on rr.routine_id=r.id where rr.id=$1 and m.user_id=$2`,
        [task.id, task.owner_id],
      )
    ).rows[0];
    if (member && (member.scope !== "org" || member.role === "admin") && task.sandbox_id && task.prompt_id) {
      try {
        const observed = await runtime.observe(
          { userId: task.owner_id, orgs: [{ orgId: task.org_id }] },
          {
            sandboxId: task.sandbox_id,
            promptId: task.prompt_id,
            ...(task.conversation_id ? { conversationId: task.conversation_id } : {}),
          },
          signal,
        );
        if (!signal.aborted && ["running", "finished", "failed", "interrupted", "unknown"].includes(observed))
          state = observed;
      } catch {
        /* Unavailable evidence is unknown, not a synthetic task failure. */
      }
    }
    if (signal.aborted) return true;
    await sql.query(
      `update public.routine_runs set task_state=$3,task_check_id=null,updated_at=now()
      where id=$1 and task_check_id=$2 and state='succeeded' and task_state in ('running','unknown')`,
      [task.id, task.task_check_id, state],
    );
    return true;
  }
  // Separate provider and operation budgets: an unavailable provider cannot occupy
  // another provider's slots, and observation never consumes dispatch capacity.
  const providers = ["boat", "modal", "docker", "unknown"];
  const dispatches = new Set<string>();
  const effects = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();
  let running = false;
  let stopped = false;
  function track(key: string, work: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    controllers.add(controller);
    if (stopped) controller.abort();
    // Deadline only requests cancellation: it never releases the raw-effect slot.
    const timer = setTimeout(() => controller.abort(), 60_000);
    timer.unref();
    const effect = Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        () => {},
        () => {
          // Durable leases/claims retain failed publication for later recovery.
        },
      )
      .finally(() => {
        clearTimeout(timer);
        controllers.delete(controller);
        effects.delete(key);
      });
    effects.set(key, effect);
  }
  function trackDispatch(key: string, run: Run) {
    dispatches.add(run.id);
    track(key, async (signal) => {
      try {
        await dispatch(run, signal);
      } finally {
        dispatches.delete(run.id);
      }
    });
  }
  return {
    /** Shutdown owns raw effects; callers must apply their process shutdown grace period. */
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
    },
    async drain() {
      while (effects.size) await Promise.all([...effects.values()]);
    },
    async tick(signal?: AbortSignal): Promise<void> {
      if (running || stopped || signal?.aborted) return;
      running = true;
      try {
        for (const provider of providers) {
          if (stopped || signal?.aborted) break;
          const dispatchKey = `dispatch:${provider}`;
          if (!effects.has(dispatchKey)) {
            let run: Run | undefined;
            for (let i = 0; i < 25; i++) {
              const candidate = await admit(provider);
              if (candidate === null) break;
              if (candidate) {
                run = candidate;
                break;
              }
            }
            if (run) trackDispatch(dispatchKey, run);
          }
          const recoveryKey = `recovery:${provider}`;
          if (!effects.has(recoveryKey)) {
            const recovered = await leaseRecovery(provider);
            if (recovered) trackDispatch(recoveryKey, recovered);
          }
          const observeKey = `observe:${provider}`;
          if (!effects.has(observeKey)) track(observeKey, (effectSignal) => observeTask(provider, effectSignal));
        }
      } finally {
        running = false;
      }
    },
  };
}
