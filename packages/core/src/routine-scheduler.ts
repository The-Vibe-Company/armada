import type { ApplicationVaultActor } from "./application-vault.ts";
import type { Sql } from "./golden-store.ts";

export interface RoutineLaunchAdmission {
  /** Called by the template launch immediately before provider allocation, after the claim is durable. */
  beforeFork(): Promise<void>;
}

export type RoutineTaskState = "running" | "finished" | "failed" | "interrupted" | "unknown";

export interface RoutineSchedulerRuntime {
  /** Observe only the original prompt, never the latest conversation turn. */
  observe(
    actor: ApplicationVaultActor,
    prompt: { sandboxId: string; promptId: string; conversationId?: string },
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
  interval_hours: number;
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
  id: string;
  state: string;
  sandbox_id: string;
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
  async function settle(run: Run, state: "succeeded" | "failed" | "reconciling", claim?: Claim, reason?: string) {
    await transaction(async (tx) => {
      await tx.query("select id from public.routines where id=$1 for update", [run.routine_id]);
      const changed = await tx.query(
        `update public.routine_runs set state=$3,reason=$4,template_request_id=$5,sandbox_id=$6,
         prompt_id=$7,conversation_id=$8,
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
        "select id,state,sandbox_id,result->>'promptId' as prompt_id,result->>'conversationId' as conversation_id from public.template_launch_requests where org_id=$1 and actor_id=$2 and client_key=$3",
        [run.org_id, run.owner_id, run.request_key],
      )
    ).rows[0];
  }
  async function reconcile(run: Run, claim: Claim) {
    if (claim.state === "succeeded") return settle(run, "succeeded", claim);
    if (claim.state === "failed") return settle(run, "failed", claim, "launch_failed");
    // A nonterminal template call may still publish/start after an observed stop. Only its
    // own terminal claim can resolve uncertainty; a sandbox status alone cannot fence it.
    return settle(run, "reconciling", claim, "launch_uncertain");
  }
  async function dispatch(run: Run) {
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
      await runtime.launch(
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
          beforeFork: async () => {
            // A preflight can outlive its lease while another replica concludes that no claim
            // exists. Fence that stale caller at the provider boundary, not just history publication.
            const current = await sql.query(
              "select id from public.routine_runs where id=$1 and state='admitted' and lease_id=$2",
              [run.id, run.lease_id],
            );
            if (!current.rows.length) throw Error("Routine launch admission expired.");
          },
        },
      );
    } catch {
      const claim = await templateClaim(run);
      if (claim) return reconcile(run, claim);
      return settle(run, "failed", undefined, "launch_failed");
    }
    const claim = await templateClaim(run);
    // A normal template launch leaves its durable claim. Do not treat unexplained absence as
    // permission to allocate another key; retain a visible uncertain occurrence.
    if (!claim) return settle(run, "reconciling", undefined, "launch_uncertain");
    return reconcile(run, claim);
  }
  async function leaseRecovery(): Promise<Run | undefined> {
    return transaction(async (tx) => {
      const run = (
        await tx.query<Run>(
          `select * from public.routine_runs where state in ('admitted','reconciling')
         and (lease_until is null or lease_until<=now()) order by created_at,id for update skip locked limit 1`,
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
  async function admit(): Promise<Run | undefined | null> {
    return transaction(async (tx) => {
      const routine = (
        await tx.query<Routine>(
          "select * from public.routines where status='enabled' and next_due_at<=now() order by next_due_at,id for update skip locked limit 1",
        )
      ).rows[0];
      if (!routine) return null;
      const previous = (
        await tx.query<{ state: string; sandbox_id: string | null; status: string | null; deleted_at: string | null }>(
          `select rr.state,rr.sandbox_id,s.status,s.deleted_at from public.routine_runs rr
         left join public.sandboxes s on s.id=rr.sandbox_id
         where rr.routine_id=$1 and (
          rr.state in ('admitted','reconciling') or
          ((rr.sandbox_id is not null or rr.state='succeeded') and
           (s.id is null or (s.status not in ('stopped','deleted') and not (s.status='failed' and s.stopped_at is not null) and s.deleted_at is null))))
         order by case when rr.state in ('admitted','reconciling') or s.id is null then 0 else 1 end limit 1`,
          [routine.id],
        )
      ).rows[0];
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
      ).rows[0]!.count;
      if (!reason && count >= routine.max_runs_per_day) reason = "daily_limit_reached";
      const run = (
        await tx.query<Run>(
          `insert into public.routine_runs(routine_id,org_id,owner_id,scheduled_due_at,configuration_version,state,reason,request_key,missed_intervals,lease_id,lease_until)
         values($1,$2,$3,$4,$5,$6,$7,'routine:'||gen_random_uuid()::text,
          floor(extract(epoch from (now()-$4::timestamptz))/($8*3600))::int,
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
            routine.interval_hours,
          ],
        )
      ).rows[0]!;
      await tx.query(
        `update public.routines set next_due_at=$2::timestamptz+
        (floor(extract(epoch from (now()-$2::timestamptz))/($3*3600))+1)*($3*interval '1 hour') where id=$1`,
        [routine.id, routine.next_due_at, routine.interval_hours],
      );
      if (reason) return undefined;
      await tx.query(
        "insert into public.routine_run_inputs(run_id,template_id,template_revision,prompt,ttl_seconds) values($1,$2,$3,$4,$5)",
        [run.id, routine.template_id, routine.template_revision, routine.prompt, routine.ttl_seconds],
      );
      return run;
    });
  }
  async function observeTask(): Promise<boolean> {
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
        }>(`select * from public.routine_runs where state='succeeded' and task_state in ('running','unknown')
          and (task_checked_at is null or task_checked_at<=now()-interval '1 minute')
          order by task_checked_at nulls first,id for update skip locked limit 1`)
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
        );
        if (["running", "finished", "failed", "interrupted", "unknown"].includes(observed)) state = observed;
      } catch {
        /* Unavailable evidence is unknown, not a synthetic task failure. */
      }
    }
    await sql.query(
      `update public.routine_runs set task_state=$3,task_check_id=null,updated_at=now()
      where id=$1 and task_check_id=$2 and state='succeeded' and task_state in ('running','unknown')`,
      [task.id, task.task_check_id, state],
    );
    return true;
  }
  let running = false;
  return {
    async tick(signal?: AbortSignal): Promise<void> {
      if (running) return;
      running = true;
      try {
        for (let i = 0; i < 25 && !signal?.aborted; i++) {
          const run = await leaseRecovery();
          if (!run) break;
          await dispatch(run);
        }
        for (let i = 0; i < 25 && !signal?.aborted; i++) {
          if (!(await observeTask())) break;
        }
        for (let i = 0; i < 25 && !signal?.aborted; i++) {
          const run = await admit();
          if (run === null) break;
          if (run) await dispatch(run);
        }
      } finally {
        running = false;
      }
    },
  };
}
