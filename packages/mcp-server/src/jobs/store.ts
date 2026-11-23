import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { ModalMachineJournal } from "@armada/provider-modal";
import {
  COMPLETED_RUNTIME_WAKE,
  CONFIRMED_WAKE_WITHOUT_TICKET,
  CURRENT_DOCKER_RESUME_JOB,
  DISPATCH_ABANDONED,
  DISPATCHING_TURN_CANCELLED,
  DOCKER_RESUME_WITHOUT_DISPATCH_DEADLINE,
  ENROLLED_PENDING_RUNTIME_WAKE,
  FAILED_DOCKER_WAKE,
  failTurnReceipt,
  NATIVE_DISPATCH_UNCERTAIN,
  PENDING_READY_DOCKER_RESUME_ACK,
  QUEUED_DISPATCH_EVIDENCE,
  QUEUED_TURN_CANCELLED,
  RUNTIME_LANE,
  resetAbandonedTurn,
} from "../account-turn-dispatch.ts";
import type { ModalLaunchHandoff } from "../modal-launch-handoff.ts";
import { createJobsEnqueue } from "./enqueue.ts";

export { ConflictingJobRequest, JOBS_WAKE, jobRequestKey } from "./enqueue.ts";

import type { Job, JobStore } from "./runner.ts";

type JobRow = Omit<Job, "payload"> & { payload_enc: string | null };

const fence = "j.id = $1 and j.lease_owner = $2 and j.lease_epoch = $3 and j.lease_until > clock_timestamp()";
const claimIdentity = (job: Job, owner: string) => [job.id, owner, job.lease_epoch];
const claimKey = (job: Job, owner: string) => [...claimIdentity(job, owner), job.generation];

const ADJACENT_RUNTIME_DISPATCH = `(q.state = 'dispatching'
  and q.dispatch_generation = s.lifecycle_generation - 1
  and s.provider in ('boat','modal','docker') and ${RUNTIME_LANE})`;

const NO_ADJACENT_DISPATCH_EVIDENCE = `(s.activity_lease_id is distinct from q.request_id
  and not ${QUEUED_DISPATCH_EVIDENCE}
  and (s.provider <> 'docker' or not exists(
    select 1 from public.docker_resume_claims c where c.sandbox_id = s.id and c.request_id = q.request_id
  )))`;

const OBSOLETE_RUNTIME_PROMPT = `(s.activity_lease_id is distinct from q.request_id
  and (s.provider <> 'docker' or (
    not exists(select 1 from public.docker_resume_claims dc
      where dc.sandbox_id = s.id and dc.request_id = q.request_id)
    and not exists(select 1 from public.docker_host_jobs dj
      where dj.bound_sandbox_id = s.id and dj.request_id = q.request_id)
  ))
  and exists(
    select 1 from public.runtime_commands c
    join public.runtime_enrolments e on e.sandbox_id = c.sandbox_id
    where c.sandbox_id = s.id and c.request_id = (case when s.provider = 'docker' then 'docker_prompt_' else 'follow_' end) || q.request_id::text
      and c.result_enc is not null and c.epoch < e.epoch
      and e.runtime_hash is not null and e.lifecycle_generation = s.lifecycle_generation
  )
  and not exists(
    select 1 from public.runtime_resumes r where r.sandbox_id = s.id and r.request_id = q.request_id
  ))`;

const CURRENT_DOCKER_PROMPT_COMMAND = `(s.provider = 'docker' and exists(
  select 1 from public.runtime_commands c
  join public.runtime_enrolments e on e.sandbox_id = c.sandbox_id and e.epoch = c.epoch
  join public.docker_hosts h on h.id = s.docker_host_id and h.org_id = s.org_id
    and h.installation_id = s.docker_installation_id
  join public.members m on m.org_id = h.org_id and m.user_id = h.owner_id
  join public.mcp_actor_epochs a on a.org_id = m.org_id and a.user_id = m.user_id
  where c.sandbox_id = s.id and c.request_id = 'docker_prompt_' || q.request_id::text
    and e.runtime_hash is not null
    and e.lifecycle_generation = s.lifecycle_generation
    and e.docker_issuer_fence = h.owner_id::text || ':' || a.epoch::text
    and h.hash is not null and h.registration_hash is null and h.revoked_at is null
))`;

export async function withJobLease<T>(sql: Sql, job: Job, write: (tx: Sql) => Promise<T>) {
  if (!sql.transaction) throw new Error("Job checkpoint requires a transaction.");
  return sql.transaction(async (tx) => {
    const { rows: sandboxes } = await tx.query(
      "select id from public.sandboxes where id=$1 and lifecycle_generation=$2 for update",
      [job.sandbox_id, job.generation],
    );
    if (!sandboxes.length) return;
    const { rows: jobs } = await tx.query(
      `select id from public.jobs where id=$1 and lease_epoch=$2 and lease_until > clock_timestamp()
       and sandbox_id=$3 and generation=$4 and kind=$5 for update`,
      [job.id, job.lease_epoch, job.sandbox_id, job.generation, job.kind],
    );
    if (jobs.length) return write(tx);
  });
}

export async function adoptObservedModalAllocation(tx: Sql, job: Job, machineId: string) {
  const { rows } = await tx.query(
    `update public.jobs set outcome=case
       when outcome #>> '{modal_machine,entry,phase}'='allocated' then outcome
       else jsonb_set(outcome,'{modal_machine,entry}',outcome #> '{modal_machine,entry}' ||
         jsonb_build_object('phase','allocated','machineId',$3::text,
           'revision',(outcome #>> '{modal_machine,entry,revision}')::int+1))
       end
     where id=$1 and kind='launch' and lease_epoch=$2 and lease_until>clock_timestamp()
       and outcome #>> '{modal_machine,entry,operation}'='create'
       and ((outcome #>> '{modal_machine,entry,phase}'='creating'
             and outcome #>> '{modal_machine,entry,machineId}' is null)
         or (outcome #>> '{modal_machine,entry,phase}'='allocated'
             and outcome #>> '{modal_machine,entry,machineId}'=$3))
     returning id`,
    [job.id, job.lease_epoch, machineId],
  );
  return rows.length > 0;
}

// WARNING: Record the replay token inside the fenced ticket issuance transaction.
export async function recordModalBootstrapTicket(
  tx: Sql,
  job: Job,
  token: string,
  encryptionKey: string,
  machineId: string,
  handoff: ModalLaunchHandoff | undefined,
) {
  const sealed = await encryptSecret(token, encryptionKey);
  const { rows } = await tx.query(
    `update public.jobs set outcome=outcome ||
       jsonb_build_object('bootstrap_ticket_enc',$2::text,
         'modal_handoff',coalesce(outcome->'modal_handoff',$3::jsonb))
     where id=$1 and lease_epoch=$4 and lease_until>clock_timestamp()
       and outcome #>> '{modal_machine,entry,machineId}'=$5
       and (outcome->'modal_handoff' is not null
         or ($3::jsonb is not null and outcome->'bootstrap_ticket_enc' is null))
     returning id`,
    [
      job.id,
      Buffer.from(sealed).toString("base64"),
      handoff ? JSON.stringify(handoff) : null,
      job.lease_epoch,
      machineId,
    ],
  );
  return rows.length === 1;
}

// WARNING: Only call inside a fenced job completion after requeueing the job.
export async function rescheduleRecurringJob(tx: Sql, job: Job, after: Date) {
  await tx.query("update public.jobs set attempts=0,run_after=$2 where id=$1", [job.id, after]);
}

export function createJobsStore(sql: Sql, encryptionKey?: string) {
  async function reconcileTurnClaim(job: Job, owner: string, phase: "claim" | "no_dispatch" | "after_handler") {
    const sandboxId = job.sandbox_id;
    if (
      !sandboxId ||
      !job.payload ||
      typeof job.payload !== "object" ||
      !("requestId" in job.payload) ||
      typeof job.payload.requestId !== "string"
    )
      throw new Error("Turn job is missing its sandbox or request ID.");
    if (!sql.transaction) throw new Error("Turn claim reconciliation requires a transaction.");
    const requestId = job.payload.requestId;
    const claim = claimKey(job, owner);
    const retiring = phase !== "claim";
    try {
      return await sql.transaction(async (tx) => {
        // WARNING: Acquire the write lock first to avoid a table lock upgrade against startup model repair.
        await tx.query("lock table public.account_turn_queue in row exclusive mode nowait");
        const {
          rows: [receipt],
        } = await tx.query<{ state: string; account_id: string }>(
          `select state, account_id from public.account_turn_queue
           where sandbox_id = $1 and request_id = $2 for update nowait`,
          [sandboxId, requestId],
        );
        if (!receipt || receipt.state === "admitted" || receipt.state === "failed") {
          await tx.query(
            `update public.jobs j set state = 'done', lease_owner = null, lease_until = null
             where ${fence} and (j.generation = $4 or $5::boolean)`,
            [...claim, retiring],
          );
          return job;
        }
        // WARNING: Owner stop can hold the sandbox lock while waiting for the receipt.
        await tx.query("select id from public.sandboxes where id = $1 for update nowait", [sandboxId]);
        const {
          rows: [sandbox],
        } = await tx.query<{
          generation: string;
          cancelled: boolean;
          queued_with_evidence: boolean;
          native_uncertain: boolean;
          failed_docker_wake: boolean;
          abandoned: boolean;
          unrecoverable_dispatch: boolean;
          defer_dispatch_until: string | null;
        }>(
          `select s.lifecycle_generation::text as generation,
                  case when q.state = 'queued' then ${QUEUED_TURN_CANCELLED}
                       else ${DISPATCHING_TURN_CANCELLED} end as cancelled,
                  (q.state = 'queued' and ${QUEUED_DISPATCH_EVIDENCE}) as queued_with_evidence,
                  (q.state = 'dispatching' and (q.dispatch_until is null or q.dispatch_until <= clock_timestamp())
                    and ${NATIVE_DISPATCH_UNCERTAIN}) as native_uncertain,
                  (q.state = 'dispatching' and ${FAILED_DOCKER_WAKE}) as failed_docker_wake,
                  (q.state = 'dispatching' and ${DISPATCH_ABANDONED}
                    and (s.lifecycle_generation = $3 or s.status in ('ready','running'))) as abandoned,
                  (q.state = 'dispatching' and (q.dispatch_generation is null
                    or q.dispatch_generation < s.lifecycle_generation - 1
                    or (${ADJACENT_RUNTIME_DISPATCH} and s.status in ('ready','running')
                      and (q.dispatch_until is null or q.dispatch_until <= statement_timestamp())
                      and (${NO_ADJACENT_DISPATCH_EVIDENCE} or ${OBSOLETE_RUNTIME_PROMPT}))))
                    as unrecoverable_dispatch,
                  case when ${ADJACENT_RUNTIME_DISPATCH}
                    and (s.status in ('ready','running')
                      or (s.status = 'starting'
                        and s.activity_lease_id is null and ${CURRENT_DOCKER_RESUME_JOB}))
                    and isfinite(q.dispatch_until) and q.dispatch_until > statement_timestamp()
                    then q.dispatch_until::text
                    when ${ADJACENT_RUNTIME_DISPATCH} and ${PENDING_READY_DOCKER_RESUME_ACK}
                    then least(s.expires_at, statement_timestamp() + interval '1 second')::text
                  end as defer_dispatch_until
           from public.sandboxes s join public.account_turn_queue q on q.sandbox_id = s.id
           where s.id = $1 and q.request_id = $2`,
          [sandboxId, requestId, job.generation],
        );
        if (
          sandbox?.cancelled ||
          sandbox?.queued_with_evidence ||
          sandbox?.native_uncertain ||
          sandbox?.failed_docker_wake
        ) {
          const reason = sandbox.cancelled
            ? "cancelled_receipt"
            : sandbox.queued_with_evidence
              ? "queued_dispatch_evidence"
              : sandbox.native_uncertain
                ? "native_dispatch_uncertain"
                : "docker_wake_failed";
          if (await retireClaim(tx, job, owner, sandbox.generation, reason))
            await failTurnReceipt(
              tx,
              sandboxId,
              requestId,
              reason === "native_dispatch_uncertain" || reason === "docker_wake_failed",
            );
          return job;
        }
        let reset = false;
        if (!retiring && sandbox?.abandoned) {
          await tx.query("select id from public.credentials where id = $1 for update nowait", [receipt.account_id]);
          const { rows } = await tx.query(
            `select j.id from public.jobs j where ${fence} and j.generation = $4 and j.generation <= $5 for update nowait`,
            [...claim, sandbox.generation],
          );
          if (rows.length) reset = await resetAbandonedTurn(tx, sandboxId, requestId);
        }
        if (receipt.state === "queued" || sandbox?.generation !== job.generation) {
          const {
            rows: [updated],
          } = await tx.query<{ generation: string }>(
            `update public.jobs j set generation = s.lifecycle_generation,
               state = case when $6::boolean then 'queued' else j.state end,
               lease_owner = case when $6 then null else j.lease_owner end,
               lease_until = case when $6 then null else j.lease_until end,
               attempts = case when $7::boolean then j.attempts - 1 else j.attempts end
             from public.sandboxes s join public.account_turn_queue q on q.sandbox_id = s.id
             where ${fence} and (j.generation = $4 or $6) and q.request_id = $5 and s.id = j.sandbox_id
               and s.lifecycle_generation > j.generation
               and s.deleted_at is null and s.stop_requested_at is null and s.expires_at > now()
               and ((q.state = 'queued' and s.status in ('ready','running') and not ${QUEUED_DISPATCH_EVIDENCE})
                 or (q.state = 'dispatching' and ${RUNTIME_LANE}
                   and s.status in ('starting','ready','running')
                   and q.dispatch_generation in (s.lifecycle_generation, s.lifecycle_generation - 1)
                   and (${COMPLETED_RUNTIME_WAKE} or ${ENROLLED_PENDING_RUNTIME_WAKE}
                     or ${CONFIRMED_WAKE_WITHOUT_TICKET} or ${DOCKER_RESUME_WITHOUT_DISPATCH_DEADLINE}
                     or (q.dispatch_until <= clock_timestamp()
                     and (s.activity_lease_id = q.request_id
                       or (s.activity_lease_id is null and ${CURRENT_DOCKER_RESUME_JOB})
                       or (s.activity_lease_id is null and s.status in ('ready','running')
                         and (${CURRENT_DOCKER_PROMPT_COMMAND} or (s.provider in ('boat','modal') and exists(
                           select 1 from public.runtime_commands c
                           join public.runtime_enrolments e on e.sandbox_id = c.sandbox_id and e.epoch = c.epoch
                           where c.sandbox_id = s.id and c.request_id = 'follow_' || q.request_id::text
                             and c.result_enc is not null and e.runtime_hash is not null
                             and e.lifecycle_generation = s.lifecycle_generation
                         )))))))))
             returning j.generation::text`,
            [...claim, requestId, retiring, phase === "no_dispatch"],
          );
          if (updated) return { ...job, generation: updated.generation };
          if (reset) throw new Error("Abandoned turn reset lost its generation fence.");
        }
        if (retiring && sandbox?.defer_dispatch_until) {
          const { rows } = await tx.query(
            `update public.jobs j set state = 'queued', lease_owner = null, lease_until = null, run_after = $4,
               attempts = case when $6::boolean then j.attempts - 1 else j.attempts end
             where ${fence} and j.generation < $5 returning j.id`,
            [...claimIdentity(job, owner), sandbox.defer_dispatch_until, sandbox.generation, phase === "no_dispatch"],
          );
          if (rows.length) return job;
        }
        if (
          retiring &&
          (await retireClaim(tx, job, owner, sandbox?.generation ?? null)) &&
          sandbox?.unrecoverable_dispatch
        )
          await failTurnReceipt(tx, sandboxId, requestId, true);
        return job;
      });
    } catch (error) {
      const fields = error as { errno?: string; code?: string } | null;
      if ((fields?.errno ?? fields?.code) !== "55P03") throw error;
      if (phase !== "after_handler")
        await sql.query(
          `update public.jobs j set state = 'queued', lease_owner = null, lease_until = null,
             attempts = attempts - 1, run_after = clock_timestamp() + interval '1 second'
           where ${fence} and j.generation = $4`,
          claim,
        );
      return job;
    }
  }

  async function retireClaim(
    tx: Sql,
    job: Job,
    owner: string,
    generation: string | null,
    reason:
      | "stale_generation"
      | "cancelled_receipt"
      | "queued_dispatch_evidence"
      | "docker_wake_failed"
      | "native_dispatch_uncertain" = "stale_generation",
  ) {
    const { rows } = await tx.query(
      `update public.jobs j set state = 'failed', lease_owner = null, lease_until = null,
         payload_enc=case when kind='outputs_publish' then null else payload_enc end,
         outcome = coalesce(case when kind='launch' and jsonb_typeof(outcome)='object'
                                 then outcome - 'bootstrap_ticket_enc' - 'modal_handoff' else outcome end, '{}'::jsonb) || jsonb_build_object('reason', $6::text)
       where ${fence} and (j.kind = 'turn_dispatch' or j.generation = $4)
         and (j.generation is distinct from $5 or $6 <> 'stale_generation') returning j.id`,
      [...claimKey(job, owner), generation, reason],
    );
    return rows.length > 0;
  }

  async function withLockedTurnGeneration<T>(
    job: Job,
    owner: string,
    work: (db: Sql, generation: string | null) => Promise<T>,
    lockPrerequisites?: (tx: Sql) => Promise<void>,
  ) {
    if (job.kind !== "turn_dispatch") return work(sql, job.generation);
    if (!sql.transaction) throw new Error("Turn job fencing requires a transaction.");
    return sql.transaction(async (tx) => {
      await lockPrerequisites?.(tx);
      await tx.query("select id from public.sandboxes where id = $1 for update", [job.sandbox_id]);
      const { rows } = await tx.query<{ generation: string }>(
        `select j.generation::text from public.jobs j
         join public.sandboxes s on s.id = j.sandbox_id and s.lifecycle_generation = j.generation
         where ${fence} and j.kind = 'turn_dispatch'`,
        claimIdentity(job, owner),
      );
      if (rows[0]) return work(tx, rows[0].generation);
      if (lockPrerequisites) throw new Error("Turn job lease is no longer current.");
    });
  }

  function modalMachineJournal(
    job: Job,
    journalJobId: string,
    isCurrent: (tx: Sql) => Promise<boolean> | boolean,
    mayWrite: (
      tx: Sql,
      revision: number | undefined,
      next: Parameters<ModalMachineJournal["compareAndSet"]>[2],
    ) => Promise<boolean>,
    checkpointPath = "{modal_machine}",
  ) {
    return {
      async read(key) {
        const checkpoint = await withJobLease(sql, job, async (tx) => {
          if (!(await isCurrent(tx))) return;
          const { rows } = await tx.query<{
            checkpoint: { key: string; entry: Awaited<ReturnType<ModalMachineJournal["read"]>> } | null;
          }>(
            `select outcome #> $2::text[] as checkpoint from public.jobs where id=$1
           and exists (select 1 from public.jobs claim where claim.id=$3 and claim.lease_until>clock_timestamp())`,
            [journalJobId, checkpointPath, job.id],
          );
          return rows[0]?.checkpoint;
        });
        if (checkpoint === undefined) throw new Error("Modal machine journal claim is no longer current.");
        if (checkpoint && checkpoint.key !== key) throw new Error("Modal launch journal key changed.");
        return checkpoint?.entry;
      },
      async compareAndSet(key, revision, next) {
        if (next.revision !== (revision ?? 0) + 1) return false;
        return (
          (await withJobLease(sql, job, async (tx) => {
            if (!(await isCurrent(tx)) || !(await mayWrite(tx, revision, next))) return false;
            const { rows } = await tx.query(
              `update public.jobs set outcome=jsonb_set(
               case when outcome is null then '{}'::jsonb
                    when jsonb_typeof(outcome) = 'object' then outcome
                    else jsonb_build_object('result', outcome) end,
               $6::text[], $2::jsonb)
             where id=$1
               and exists (select 1 from public.jobs claim where claim.id=$5 and claim.lease_until>clock_timestamp())
               and (outcome #> $6::text[] is null or (outcome #> $6::text[])->>'key' = $3)
               and ((outcome #> $6::text[])->'entry'->>'revision')::integer is not distinct from $4::integer
             returning id`,
              [journalJobId, JSON.stringify({ key, entry: next }), key, revision ?? null, job.id, checkpointPath],
            );
            return rows.length > 0;
          })) ?? false
        );
      },
    } satisfies ModalMachineJournal;
  }

  return {
    modalStopJournal(job: Job, canDispatch: (tx: Sql) => Promise<boolean>) {
      return modalMachineJournal(
        job,
        job.id,
        async () => true,
        async (tx, _revision, next) => next.phase === "stopped" || Boolean(next.recoveryImageId) || canDispatch(tx),
      );
    },
    async checkpointStopCapture(tx: Sql, job: Job) {
      const { rows } = await tx.query(
        `update public.jobs set outcome=jsonb_set(coalesce(outcome, '{}'::jsonb), '{captured}', 'true')
         where id=$1 and lease_epoch=$2 and state='leased' and lease_until>clock_timestamp() returning id`,
        [job.id, job.lease_epoch],
      );
      return rows.length > 0;
    },
    modalLaunchJournal(job: Job, canCreate?: (tx: Sql) => Promise<boolean>) {
      if (job.kind !== "launch" || !job.sandbox_id || !job.generation) {
        throw new Error("Modal machine journal requires a launch claim.");
      }
      return modalMachineJournal(
        job,
        job.id,
        () => true,
        async (tx, revision, next) =>
          next.phase !== "creating" || revision !== undefined || !canCreate || canCreate(tx),
      );
    },
    modalFailedLaunchJournal(
      job: Job,
      launchJobId: string,
      isCurrent: (tx: Sql) => Promise<boolean>,
      canDispatch: (tx: Sql) => Promise<boolean>,
    ) {
      if (job.kind !== "delete" || !job.sandbox_id || !job.generation) {
        throw new Error("Modal failed launch journal requires a delete claim.");
      }
      return modalMachineJournal(
        job,
        launchJobId,
        isCurrent,
        async (tx, _revision, next) => next.phase === "deleted" || canDispatch(tx),
        "{evidence,modal_machine}",
      );
    },
    enqueue: createJobsEnqueue(sql, encryptionKey),
    async claim(kind, owner, seconds, concurrency) {
      const claimStartedAt = performance.now();
      const { rows } = await sql.query<JobRow & { dispatch_budget_ms: number | null }>(
        `select id, kind, sandbox_id, generation::text, lease_epoch::text, attempts, max_attempts, outcome,
                case when kind = 'boat_runtime_extend' and lease_until = deadline_at
                     then (1000 * extract(epoch from deadline_at - statement_timestamp()))::double precision
                end as dispatch_budget_ms,
                encode(payload_enc, 'hex') as payload_enc
         from public.claim_job($1,$2,$3,$4)`,
        [kind, owner, seconds, concurrency],
      );
      if (!rows[0]) return;
      const { payload_enc, dispatch_budget_ms, ...job } = rows[0];
      const payload =
        payload_enc === null
          ? null
          : JSON.parse(await decryptSecret(Uint8Array.from(Buffer.from(payload_enc, "hex")), encryptionKey));
      const claimed = {
        ...job,
        payload,
        ...(dispatch_budget_ms == null
          ? {}
          : { dispatchBudgetMs: Math.floor(dispatch_budget_ms - (performance.now() - claimStartedAt)) }),
      };
      return kind === "turn_dispatch" ? reconcileTurnClaim(claimed, owner, "claim") : claimed;
    },
    async inspect(job, owner, tx?: Sql) {
      const { rows } = await (tx ?? sql).query<{ state: "dispatch" | "reconcile" | "stale" }>(
        `select case when j.generation is not null and s.lifecycle_generation is distinct from j.generation
                       then 'stale'
                     when j.attempts > j.max_attempts or j.deadline_at <= clock_timestamp()
                       then 'reconcile'
                     else 'dispatch' end as state
         from public.jobs j left join public.sandboxes s on s.id = j.sandbox_id
         where ${fence} and (j.kind = 'turn_dispatch' or j.generation is not distinct from $4) ${tx ? "for update of j" : ""}`,
        claimKey(job, owner),
      );
      return rows[0]?.state ?? "lost";
    },
    async retireStale(job, owner, phase) {
      if (job.generation === null) return;
      if (job.kind === "turn_dispatch") {
        await reconcileTurnClaim(job, owner, phase ?? "after_handler");
        return;
      }
      if (!sql.transaction) throw new Error("Job retirement requires a transaction.");
      await sql.transaction(async (tx) => {
        const { rows: sandboxRows } = await tx.query<{ generation: string }>(
          "select lifecycle_generation::text as generation from public.sandboxes where id = $1 for update",
          [job.sandbox_id],
        );
        await retireClaim(tx, job, owner, sandboxRows[0]?.generation ?? null);
      });
    },
    async handoffGeneration(job, owner, handoff) {
      if (job.kind !== "turn_dispatch" || job.generation === null)
        throw new Error("Only a sandbox turn job can hand off its generation.");
      const generation = await withLockedTurnGeneration(
        job,
        owner,
        async (tx, current) => {
          const claim = claimKey(job, owner);
          const { rows } = await tx.query(
            `select j.id from public.jobs j where ${fence} and j.generation = $4
             and j.attempts <= j.max_attempts and (j.deadline_at is null or j.deadline_at > clock_timestamp())
           for update`,
            claim,
          );
          if (current !== job.generation || !rows[0]) throw new Error("Turn job cannot admit another generation.");
          await handoff.advance(tx, job);
          const updated = await tx.query<{ generation: string }>(
            `update public.jobs j set generation = s.lifecycle_generation from public.sandboxes s
           where ${fence} and j.generation = $4 and s.id = j.sandbox_id
             and s.lifecycle_generation = j.generation + 1
             and (j.deadline_at is null or j.deadline_at > clock_timestamp())
           returning j.generation::text`,
            claim,
          );
          if (!updated.rows[0]) throw new Error("Turn admission did not advance its fenced generation.");
          return updated.rows[0].generation;
        },
        handoff.lockPrerequisites,
      );
      if (generation === undefined) throw new Error("Turn job lease is no longer current.");
      return generation;
    },
    async renew(job, owner, seconds) {
      return (
        (await withLockedTurnGeneration(job, owner, async (db, generation) => {
          const { rows } = await db.query<{ renewed: boolean }>("select public.renew_job($1,$2,$3,$4,$5) as renewed", [
            ...claimIdentity(job, owner),
            generation,
            seconds,
          ]);
          return rows[0]?.renewed === true;
        })) ?? false
      );
    },
    async complete(job, owner, result) {
      const state = result.status === "retry" ? "queued" : result.status === "fail" ? "failed" : "done";
      const outcome = result.outcome === undefined ? null : JSON.stringify(result.outcome);
      const refundAttempt = result.status === "retry" && result.unattempted;
      const complete = async (db: Sql, generation: string | null) => {
        const { rows } = await db.query<{ completed: boolean }>(
          `select public.complete_job($1,$2,$3,$4,$5,
             case when $5 = 'failed' then jsonb_build_object('reason', $8::text, 'evidence', evidence)
                  else evidence end, $7) as completed
           from (
             select case when kind = 'launch' and $6::jsonb is not null
                         then jsonb_build_object('result', $6::jsonb) ||
                           case when outcome->'modal_machine' is null then '{}'::jsonb
                                else jsonb_build_object('modal_machine', outcome->'modal_machine') end ||
                           case when $5 = 'queued' and outcome ? 'modal_handoff'
                                then jsonb_build_object('modal_handoff', outcome->'modal_handoff')
                                else '{}'::jsonb end
                         when kind = 'launch' and $5 <> 'queued' and jsonb_typeof(outcome) = 'object'
                           then outcome - 'bootstrap_ticket_enc' - 'modal_handoff'
                         else coalesce($6::jsonb, outcome) end as evidence
             from public.jobs where id = $1
           ) data`,
          [
            ...claimIdentity(job, owner),
            generation,
            state,
            outcome,
            result.status === "retry" ? result.after : null,
            result.status === "fail" ? result.reason : null,
          ],
        );
        if (rows[0]?.completed) {
          if (refundAttempt) await db.query("update public.jobs set attempts = attempts - 1 where id = $1", [job.id]);
          if (job.kind === "outputs_publish" && state !== "queued")
            await db.query("update public.jobs set payload_enc=null where id=$1", [job.id]);
          await result.commit?.(db);
        }
        return rows[0]?.completed === true;
      };
      if (job.kind === "turn_dispatch") return (await withLockedTurnGeneration(job, owner, complete)) ?? false;
      if (result.commit || refundAttempt || (job.kind === "outputs_publish" && state !== "queued")) {
        if (!sql.transaction) throw new Error("Job completion requires a transaction.");
        return sql.transaction(async (tx) => {
          if (job.kind === "outputs_publish")
            await tx.query("select id from public.sandboxes where id=$1 for update", [job.sandbox_id]);
          return complete(tx, job.generation);
        });
      }
      return complete(sql, job.generation);
    },
  } satisfies JobStore & {
    modalStopJournal: (job: Job, canDispatch: (tx: Sql) => Promise<boolean>) => ModalMachineJournal;
    checkpointStopCapture: (tx: Sql, job: Job) => Promise<boolean>;
    enqueue: (...args: never[]) => Promise<string>;
    modalLaunchJournal: (job: Job, canCreate?: (tx: Sql) => Promise<boolean>) => ModalMachineJournal;
    modalFailedLaunchJournal: (
      job: Job,
      launchJobId: string,
      isCurrent: (tx: Sql) => Promise<boolean>,
      canDispatch: (tx: Sql) => Promise<boolean>,
    ) => ModalMachineJournal;
  };
}
