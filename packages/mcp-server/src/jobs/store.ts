import { decryptSecret, encryptSecret, type Sql, toBytea } from "@armada/core/server";
import type { ModalMachineJournal } from "@armada/provider-modal";
import {
  ACCEPTED_RUNTIME_RESUME,
  DISPATCH_ABANDONED,
  DISPATCHING_TURN_CANCELLED,
  failTurnReceipt,
  NATIVE_DISPATCH_UNCERTAIN,
  QUEUED_DISPATCH_EVIDENCE,
  QUEUED_TURN_CANCELLED,
  RUNTIME_LANE,
  resetAbandonedTurn,
  TURN_DISPATCH_BUDGET_EXPIRED,
  turnJobRequest,
} from "../account-turn-dispatch.ts";
import type { ModalLaunchHandoff } from "../modal-launch-handoff.ts";
import { unresolvedResume } from "../modal-launch-handoff.ts";
import { deferTransactionWake, runtimeWakes } from "../wake-bus.ts";
import type { Job, JobStore } from "./runner.ts";

export const JOBS_WAKE = "jobs";

export function dockerStopPending(sandboxId: string, generation: string, requireDispatchBudget = false) {
  const budget = requireDispatchBudget
    ? `and stop.deadline_at > clock_timestamp()
       and (stop.attempts < stop.max_attempts or
         (stop.state='leased' and stop.lease_until > clock_timestamp() and stop.attempts = stop.max_attempts))`
    : "";
  return `exists(select 1 from public.jobs stop
    where stop.sandbox_id=${sandboxId} and stop.generation=${generation}
      and stop.kind='stop' and stop.state in ('queued','leased') ${budget})`;
}

export function jobRequestKey(orgId: string, kind: string, ownerId: string, key: string) {
  return JSON.stringify(["request", orgId, kind, ownerId, key]);
}

export async function recordDockerLaunchEvidence(
  tx: Sql,
  jobId: string,
  evidence: { docker_actor_epoch: string } | { docker_receipt: string },
) {
  await tx.query(
    "update public.jobs set outcome=coalesce(outcome,'{}'::jsonb)||$2::jsonb where id=$1 and kind='launch'",
    [jobId, JSON.stringify(evidence)],
  );
}

export class ConflictingJobRequest extends Error {
  constructor() {
    super("Conflicting job request.");
  }
}

type AuthorizeJournalCreate = (write: (tx: Sql) => Promise<boolean>) => Promise<boolean | undefined>;

type JobRow = Omit<Job, "payload"> & { payload_enc: string | null };

const fence = "j.id = $1 and j.lease_owner = $2 and j.lease_epoch = $3 and j.lease_until > clock_timestamp()";
const claimIdentity = (job: Job, owner: string) => [job.id, owner, job.lease_epoch];
const claimKey = (job: Job, owner: string) => [...claimIdentity(job, owner), job.generation];

const adjacentRuntimeDispatch = () => `(q.state = 'dispatching'
  and q.dispatch_generation = s.lifecycle_generation - 1
  and s.provider in ('boat','modal','docker') and ${RUNTIME_LANE})`;

const noAdjacentDispatchEvidence = () => `(s.activity_lease_id is distinct from q.request_id
  and not ${QUEUED_DISPATCH_EVIDENCE})`;

const OBSOLETE_RUNTIME_PROMPT = `(s.activity_lease_id is distinct from q.request_id
  and (s.provider <> 'docker' or not exists(select 1 from public.docker_host_jobs dj
      where dj.bound_sandbox_id = s.id and dj.request_id = q.request_id))
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

export function queryWithJobLease<T>(sql: Sql, job: Job, statement: string, params: unknown[] = []) {
  return sql.query<T>(
    `with locked_sandbox as materialized (
       select id, org_id, owner_id, provider, runtime_transport, boat_runtime,
              provider_sandbox_id, stop_requested_at, deleted_at, expires_at, status
       from public.sandboxes where id=$1 and lifecycle_generation=$2 for update
     ), locked_job as materialized (
       select id, sandbox_id, org_id, request_owner_id, outcome, lease_until, lease_owner, deadline_at, attempts, max_attempts
       from public.jobs where sandbox_id=(select id from locked_sandbox)
         and id=$3 and lease_epoch=$4 and generation=$2 and kind=$5 for update
     )
     ${statement}`,
    [job.sandbox_id, job.generation, job.id, job.lease_epoch, job.kind, ...params],
  );
}

export async function withJobLease<T>(
  sql: Sql,
  job: Job,
  write: (tx: Sql) => Promise<T>,
  lockPrerequisites?: (tx: Sql) => Promise<unknown>,
) {
  if (!sql.transaction) throw new Error("Job checkpoint requires a transaction.");
  return sql.transaction(async (tx) => {
    await lockPrerequisites?.(tx);
    const { rows } = await queryWithJobLease(tx, job, "select id from locked_job where lease_until>clock_timestamp()");
    if (rows.length) return write(tx);
  });
}

export async function mergeStopOutcome(tx: Sql, jobId: string, outcome: Record<string, unknown>) {
  await tx.query("update public.jobs set outcome=coalesce(outcome,'{}'::jsonb)||$2::jsonb where id=$1", [
    jobId,
    JSON.stringify(outcome),
  ]);
}

export async function recordBoatRestoreDispatch(tx: Sql, jobId: string, providerAuthority: string) {
  const { rows } = await tx.query(
    `update public.jobs set outcome=outcome||jsonb_build_object('boat_restore_dispatched',true,'boat_restore_authority',$2::text)
      where id=$1 and kind='resume' and not (outcome ? 'boat_restore_dispatched') returning id`,
    [jobId, providerAuthority],
  );
  return rows.length > 0;
}

export function recordBoatRestoreObserved(tx: Sql, jobId: string) {
  return tx.query(
    `update public.jobs set outcome=outcome||'{"boat_restore_observed":true}'::jsonb
      where id=$1 and kind='resume' and outcome ? 'boat_restore_dispatched'`,
    [jobId],
  );
}

export async function recordResumeAuthority(
  tx: Sql,
  id: string,
  generation: number,
  requestId: string,
  expiresAt: string,
  checkpoint: object,
  boatMachineId?: string,
  withoutPrompt = false,
) {
  const { rows } = await tx.query(
    `update public.jobs j set outcome=jsonb_build_object('requestId',$3::text,'expiresAt',$4::text,
       'accountId',s.credential_id,'accountVersion',s.credential_version,'actorEpoch',e.epoch::text,'checkpoint',$5::jsonb,'withoutPrompt',$7::boolean)
       || case when $6::text is not null then jsonb_build_object('boatMachineId',$6::text) else '{}'::jsonb end
     from public.sandboxes s join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id
     where s.id=$1 and j.sandbox_id=s.id and j.kind='resume' and j.generation=$2 returning j.id`,
    [id, generation, requestId, expiresAt, JSON.stringify(checkpoint), boatMachineId ?? null, withoutPrompt],
  );
  return rows.length === 1;
}

export function recordDockerRestoreEvidence(
  tx: Sql,
  jobId: string,
  evidence: { restoreDelivered: true } | { restoreFailure: string },
) {
  return tx.query(
    `update public.jobs set outcome=outcome||$2::jsonb where id=$1 and kind='resume' and state in ('queued','leased')`,
    [jobId, JSON.stringify(evidence)],
  );
}

export function recordResumeBootstrapTicket(tx: Sql, jobId: string, ciphertext: string) {
  return tx.query(
    "update public.jobs set outcome=outcome||jsonb_build_object('bootstrap_ticket_enc',$2::text) where id=$1 and kind='resume'",
    [jobId, ciphertext],
  );
}

export function recordResumeBootstrapAcknowledged(tx: Sql, jobId: string) {
  return tx.query(
    `update public.jobs set outcome=outcome||'{"bootstrap_acknowledged":true}'::jsonb
      where id=$1 and kind='resume'`,
    [jobId],
  );
}

async function scheduleJobsWake(tx: Sql) {
  if (deferTransactionWake(tx, JOBS_WAKE)) return;
  const deferred = await tx.transaction?.(async (raw) => deferTransactionWake(raw, JOBS_WAKE));
  if (!deferred) runtimeWakes.notify(JOBS_WAKE);
}

export async function wakeSandboxJobs(
  tx: Sql,
  sandboxId: string,
  kinds: readonly string[],
  generation?: string | number,
) {
  await tx.query(
    `with due as (
       select id from public.jobs
       where sandbox_id = $1 and kind = any($2::text[]) and state = 'queued'
         and ($3::bigint is null or generation = $3::bigint)
         and run_after > clock_timestamp()
       order by id
       for update skip locked
     )
     update public.jobs j set run_after = clock_timestamp()
     from due where j.id = due.id`,
    [sandboxId, [...kinds], generation ?? null],
  );
  await scheduleJobsWake(tx);
}

export async function wakeEnrolledSandboxJobs(
  tx: Sql,
  sandboxId: string,
  generation: string | number,
  kinds: readonly string[],
) {
  const { rows } = await tx.query(
    `with due as (
       select j.id from public.jobs j
       where j.sandbox_id = $1 and j.kind = any($2::text[]) and j.state = 'queued'
         and j.generation = $3::bigint
         and exists(
           select 1 from public.runtime_enrolments e
           where e.sandbox_id = j.sandbox_id and e.lifecycle_generation = j.generation and e.runtime_hash is not null
         )
       order by j.id
       for update skip locked
     )
     update public.jobs j set run_after = least(j.run_after, clock_timestamp())
     from due where j.id = due.id
     returning j.id`,
    [sandboxId, [...kinds], generation],
  );
  if (rows.length) await scheduleJobsWake(tx);
}

export function clearStopCapture(tx: Sql, jobId: string, sandboxId: string, generation: string) {
  return tx.query(
    "update public.jobs set outcome=outcome-'output' where id=$1 and sandbox_id=$2 and generation=$3 and kind='stop'",
    [jobId, sandboxId, generation],
  );
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

export async function clearRefusedBoatCreate(tx: Sql, job: Job) {
  const { rows } = await tx.query(
    `update public.jobs set outcome=outcome-'modal_machine'
     where id=$1 and lease_epoch=$2 and outcome #>> '{modal_machine,entry,phase}'='creating'
     returning id`,
    [job.id, job.lease_epoch],
  );
  return rows.length === 1;
}

// WARNING: Record the replay token inside the fenced ticket issuance transaction.
export async function recordModalBootstrapTicket(
  tx: Sql,
  job: Job,
  token: string,
  encryptionKey: string,
  machineId: string,
  handoff: ModalLaunchHandoff | undefined,
  boatKeyDigest?: string,
  boatAuthority?: { scope: string; backendId: string },
) {
  const sealed = await encryptSecret(token, encryptionKey);
  const { rows } = await tx.query(
    `update public.jobs set outcome=outcome ||
       jsonb_strip_nulls(jsonb_build_object('bootstrap_ticket_enc',$2::text,'boat_authority_sha256',$6::text,'boat_authority',$7::jsonb,
         'modal_handoff',coalesce(outcome->'modal_handoff',$3::jsonb)))
     where id=$1 and lease_epoch=$4 and lease_until>clock_timestamp()
       and outcome #>> '{modal_machine,entry,machineId}'=$5
       and (outcome->'modal_handoff' is not null
         or (($3::jsonb is not null or $6::text is not null) and outcome->'bootstrap_ticket_enc' is null))
     returning id`,
    [
      job.id,
      Buffer.from(sealed).toString("base64"),
      handoff ? JSON.stringify(handoff) : null,
      job.lease_epoch,
      machineId,
      boatKeyDigest ?? null,
      boatAuthority ? JSON.stringify(boatAuthority) : null,
    ],
  );
  return rows.length === 1;
}

// WARNING: Only call inside a fenced job completion after requeueing the job.
export async function rescheduleRecurringJob(tx: Sql, job: Job, after: Date) {
  await tx.query("update public.jobs set attempts=0,run_after=$2 where id=$1", [job.id, after]);
}

interface EnqueueOptions {
  orgId: string;
  maxAttempts: number;
  deadline?: Date;
  runAfter?: Date;
  request?: { ownerId: string; digest: string };
}

export function createJobsStore(sql: Sql, encryptionKey?: string) {
  async function reconcileTurnClaim(job: Job, owner: string, phase: "claim" | "no_dispatch" | "after_handler") {
    const { sandboxId, requestId } = turnJobRequest(job);
    if (!sql.transaction) throw new Error("Turn claim reconciliation requires a transaction.");
    const claim = claimKey(job, owner);
    const retiring = phase !== "claim";
    try {
      return await sql.transaction(async (tx) => {
        // WARNING: Acquire the write lock first to avoid a table lock upgrade against startup model repair.
        await tx.query("set local lock_timeout = '750ms'");
        await tx.query("lock table public.account_turn_queue in row exclusive mode");
        await tx.query(
          "select id from public.credentials where id=(select account_id from public.account_turn_queue where sandbox_id=$1 and request_id=$2) for update",
          [sandboxId, requestId],
        );
        await tx.query("select id from public.sandboxes where id = $1 for update", [sandboxId]);
        const {
          rows: [receipt],
        } = await tx.query<{ state: string; account_id: string }>(
          `select state, account_id from public.account_turn_queue
           where sandbox_id = $1 and request_id = $2 for update`,
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
        const {
          rows: [sandbox],
        } = await tx.query<{
          generation: string;
          cancelled: boolean;
          queued_with_evidence: boolean;
          native_uncertain: boolean;
          abandoned: boolean;
          unrecoverable_dispatch: boolean;
          defer_dispatch_until: string | null;
          resuming: boolean;
        }>(
          `select s.lifecycle_generation::text as generation,
                  case when q.state = 'queued' then ${QUEUED_TURN_CANCELLED}
                       else ${DISPATCHING_TURN_CANCELLED} end as cancelled,
                  (q.state = 'queued' and ${QUEUED_DISPATCH_EVIDENCE}) as queued_with_evidence,
                  (q.state = 'dispatching' and (q.dispatch_until is null or q.dispatch_until <= clock_timestamp())
                    and ${NATIVE_DISPATCH_UNCERTAIN}) as native_uncertain,
                  (q.state = 'dispatching' and ${DISPATCH_ABANDONED}
                    and (s.lifecycle_generation = $3 or s.status in ('ready','running'))) as abandoned,
                  (q.state = 'dispatching' and (q.dispatch_generation is null
                    or q.dispatch_generation < s.lifecycle_generation - 1
                    or (${adjacentRuntimeDispatch()} and s.status in ('ready','running')
                      and (q.dispatch_until is null or q.dispatch_until <= statement_timestamp())
                      and (${noAdjacentDispatchEvidence()} or ${OBSOLETE_RUNTIME_PROMPT}))))
                    as unrecoverable_dispatch,
                  ${unresolvedResume("s")} as resuming,
                  case when ${unresolvedResume("s")} then (statement_timestamp()+interval '1 second')::text
                    when q.state='dispatching' and isfinite(q.dispatch_until)
                      and q.dispatch_until > statement_timestamp()
                    then q.dispatch_until::text
                  end as defer_dispatch_until
           from public.sandboxes s join public.account_turn_queue q on q.sandbox_id = s.id
           where s.id = $1 and q.request_id = $2`,
          [sandboxId, requestId, job.generation],
        );
        if (sandbox?.resuming && sandbox.defer_dispatch_until && !sandbox.cancelled) {
          await tx.query(
            `update public.jobs j set state='queued',lease_owner=null,lease_until=null,run_after=$4,
               attempts=greatest(attempts-1,0) where ${fence}`,
            [...claimIdentity(job, owner), sandbox.defer_dispatch_until],
          );
          return undefined;
        }
        if (sandbox?.cancelled || sandbox?.queued_with_evidence || sandbox?.native_uncertain) {
          const reason = sandbox.cancelled
            ? "cancelled_receipt"
            : sandbox.queued_with_evidence
              ? "queued_dispatch_evidence"
              : "native_dispatch_uncertain";
          if (await retireClaim(tx, job, owner, sandbox.generation, reason))
            await failTurnReceipt(tx, sandboxId, requestId, reason === "native_dispatch_uncertain");
          return job;
        }
        let reset = false;
        if (!retiring && sandbox?.abandoned) {
          const { rows } = await tx.query(
            `select j.id from public.jobs j where ${fence} and j.generation = $4 and j.generation <= $5 for update`,
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
                   and (${ACCEPTED_RUNTIME_RESUME}
                     or (q.dispatch_until <= clock_timestamp()
                     and (s.activity_lease_id = q.request_id
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
         outcome = coalesce(case when kind in ('launch','resume') and jsonb_typeof(outcome)='object'
                                 then outcome - 'bootstrap_ticket_enc' - 'modal_handoff' - 'boat_authority_sha256' else outcome end, '{}'::jsonb) || jsonb_build_object('reason', $6::text)
       where ${fence} and (j.kind = 'turn_dispatch' or j.generation = $4)
         and (j.generation is distinct from $5 or $6 <> 'stale_generation') returning j.id`,
      [...claimKey(job, owner), generation, reason],
    );
    return rows.length > 0;
  }

  async function withLockedJobGeneration<T>(
    job: Job,
    owner: string,
    work: (db: Sql, generation: string | null) => Promise<T>,
    lockPrerequisites?: (tx: Sql) => Promise<void>,
  ) {
    if (job.kind !== "turn_dispatch" && job.kind !== "stop" && job.kind !== "resume") return work(sql, job.generation);
    if (!sql.transaction) throw new Error("Job fencing requires a transaction.");
    return sql.transaction(async (tx) => {
      await lockPrerequisites?.(tx);
      await tx.query("select id from public.sandboxes where id = $1 for update", [job.sandbox_id]);
      const { rows } = await tx.query<{ generation: string }>(
        `select j.generation::text from public.jobs j
         join public.sandboxes s on s.id = j.sandbox_id and s.lifecycle_generation = j.generation
         where ${fence} and j.kind = $4`,
        [...claimIdentity(job, owner), job.kind],
      );
      if (rows[0]) return work(tx, rows[0].generation);
      if (lockPrerequisites)
        throw new Error(
          job.kind === "stop" ? "Stop job lease is no longer current." : "Turn job lease is no longer current.",
        );
    });
  }

  function modalMachineJournal(
    job: Job,
    journalJobId: string,
    isCurrent: ((tx: Sql) => Promise<boolean>) | undefined,
    mayWrite: (
      revision: number | undefined,
      next: Parameters<ModalMachineJournal["compareAndSet"]>[2],
    ) => ((tx: Sql) => Promise<boolean>) | undefined,
    checkpointPath = "{modal_machine}",
    createIfAuthorized?: AuthorizeJournalCreate,
  ) {
    return {
      async read(key) {
        type Row = { checkpoint: { key: string; entry: Awaited<ReturnType<ModalMachineJournal["read"]>> } | null };
        const checkpoint = isCurrent
          ? await withJobLease(sql, job, async (tx) => {
              if (!(await isCurrent(tx))) return;
              const { rows } = await tx.query<Row>(
                `select outcome #> $2::text[] as checkpoint from public.jobs where id=$1
                 and exists (select 1 from public.jobs claim where claim.id=$3 and claim.lease_until>clock_timestamp())`,
                [journalJobId, checkpointPath, job.id],
              );
              return rows[0]?.checkpoint;
            })
          : (
              await queryWithJobLease<Row>(
                sql,
                job,
                "select outcome #> $6::text[] as checkpoint from locked_job where lease_until>clock_timestamp()",
                [checkpointPath],
              )
            ).rows[0]?.checkpoint;
        if (checkpoint === undefined) throw new Error("Modal machine journal claim is no longer current.");
        if (checkpoint && checkpoint.key !== key) throw new Error("Modal launch journal key changed.");
        return checkpoint?.entry;
      },
      async compareAndSet(key, revision, next) {
        if (next.revision !== (revision ?? 0) + 1) return false;
        const guard = mayWrite(revision, next);
        const update = (offset: number, lease: string) => `update public.jobs set outcome=jsonb_set(
               case when outcome is null then '{}'::jsonb
                    when jsonb_typeof(outcome) = 'object' then outcome
                    else jsonb_build_object('result', outcome) end,
               $${offset + 1}::text[], $${offset + 2}::jsonb)
             where ${lease}
               and (outcome #> $${offset + 1}::text[] is null or (outcome #> $${offset + 1}::text[])->>'key' = $${offset + 3})
               and ((outcome #> $${offset + 1}::text[])->'entry'->>'revision')::integer is not distinct from $${offset + 4}::integer
             returning id`;
        const params = [checkpointPath, JSON.stringify({ key, entry: next }), key, revision ?? null];
        const write = async (tx: Sql) => {
          const { rows } = await tx.query(
            update(
              0,
              `id=$5 and exists (
               select 1 from public.jobs claim where claim.id=$6 and claim.lease_until>clock_timestamp()
             )`,
            ),
            [...params, journalJobId, job.id],
          );
          return rows.length > 0;
        };
        if (createIfAuthorized && revision === undefined && next.phase === "creating")
          return (await createIfAuthorized(write)) ?? false;
        if (!isCurrent && !guard) {
          const { rows } = await queryWithJobLease(
            sql,
            job,
            update(5, "id=(select id from locked_job where lease_until>clock_timestamp())"),
            params,
          );
          return rows.length > 0;
        }
        return (
          (await withJobLease(sql, job, async (tx) => {
            if ((isCurrent && !(await isCurrent(tx))) || (guard && !(await guard(tx)))) return false;
            return write(tx);
          })) ?? false
        );
      },
    } satisfies ModalMachineJournal;
  }

  async function enqueueWithDisposition(
    kind: string,
    sandboxId: string | null,
    generation: number | null,
    idemKey: string,
    payload: unknown,
    options: EnqueueOptions,
    tx?: Sql,
  ) {
    const db = tx ?? sql;
    const { orgId, request, deadline, runAfter, maxAttempts } = options;
    const key = request
      ? jobRequestKey(orgId, kind, request.ownerId, idemKey)
      : JSON.stringify(["internal", orgId, kind, sandboxId, generation, idemKey]);
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("Job payload must be JSON.");
    const sealed = payload === null ? null : toBytea(await encryptSecret(serialized, encryptionKey));
    const { rows: insertedRows } = await db.query<{ id: string }>(
      `insert into public.jobs
           (kind, sandbox_id, generation, idem_key, payload_enc, org_id, max_attempts, deadline_at,
            request_owner_id, request_digest, run_after)
         values ($1,$2,$3,$4,$5::text::bytea,$6,$7,$8,$9,$10,coalesce($11,now()))
         on conflict (idem_key) do nothing returning id`,
      [
        kind,
        sandboxId,
        generation,
        key,
        sealed,
        orgId,
        maxAttempts,
        deadline ?? null,
        request?.ownerId ?? null,
        request?.digest ?? null,
        runAfter ?? null,
      ],
    );
    if (insertedRows[0]) {
      if (!runAfter && !deferTransactionWake(db, JOBS_WAKE)) {
        if (!tx || tx === sql) runtimeWakes.notify(JOBS_WAKE);
        else await tx.transaction?.(async (raw) => deferTransactionWake(raw, JOBS_WAKE));
      }
      return { id: insertedRows[0].id, inserted: true };
    }
    const { rows: existingRows } = await db.query<{ id: string }>(
      `select id from public.jobs where idem_key = $1 and request_digest is not distinct from $2`,
      [key, request?.digest ?? null],
    );
    if (!existingRows[0]) throw new ConflictingJobRequest();
    return { id: existingRows[0].id, inserted: false };
  }

  return {
    modalLaunchJournal(job: Job, createIfAuthorized?: AuthorizeJournalCreate) {
      if (job.kind !== "launch" || !job.sandbox_id || !job.generation) {
        throw new Error("Modal machine journal requires a launch claim.");
      }
      return modalMachineJournal(job, job.id, undefined, () => undefined, "{modal_machine}", createIfAuthorized);
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
        (_revision, next) => (next.phase === "deleted" ? undefined : canDispatch),
        "{evidence,modal_machine}",
      );
    },
    enqueueWithDisposition,
    async enqueue(...args: Parameters<typeof enqueueWithDisposition>) {
      return (await enqueueWithDisposition(...args)).id;
    },
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
        lease_owner: owner,
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
                       or (j.kind='launch' and s.provider='docker' and ${dockerStopPending("s.id", "j.generation")})
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
      if ((job.kind !== "turn_dispatch" && job.kind !== "stop") || job.generation === null)
        throw new Error("This job cannot hand off its generation.");
      const generation = await withLockedJobGeneration(
        job,
        owner,
        async (tx, current) => {
          const claim = [...claimIdentity(job, owner), current];
          const { rows } = await tx.query(
            `select j.id from public.jobs j where ${fence} and j.generation = $4
             and j.attempts <= j.max_attempts and (j.deadline_at is null or j.deadline_at > clock_timestamp())
           for update`,
            claim,
          );
          if (current !== job.generation || !rows[0]) throw new Error("Job cannot admit another generation.");
          await handoff.advance(tx, job);
          const updated = await tx.query<{ generation: string }>(
            `update public.jobs j set generation = s.lifecycle_generation from public.sandboxes s
           where ${fence} and j.generation = $4 and s.id = j.sandbox_id
             and s.lifecycle_generation = j.generation + 1
             and (j.deadline_at is null or j.deadline_at > clock_timestamp())
           returning j.generation::text`,
            claim,
          );
          if (!updated.rows[0])
            throw new Error(
              job.kind === "stop"
                ? "Stop admission did not advance its fenced generation."
                : "Turn admission did not advance its fenced generation.",
            );
          return updated.rows[0].generation;
        },
        handoff.lockPrerequisites,
      );
      if (generation === undefined)
        throw new Error(
          job.kind === "stop" ? "Stop job lease is no longer current." : "Turn job lease is no longer current.",
        );
      if (job.kind === "stop") job.generation = generation;
      return generation;
    },
    async renew(job, owner, seconds) {
      return (
        (await withLockedJobGeneration(job, owner, async (db, generation) => {
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
        if (
          job.kind === "turn_dispatch" &&
          result.status === "fail" &&
          result.reason === TURN_DISPATCH_BUDGET_EXPIRED
        ) {
          const { requestId } = turnJobRequest(job);
          // WARNING: Check under the sandbox lock because a draining replica can admit after the claim.
          const { rows: deferred } = await db.query(
            `update public.jobs j set state='queued', lease_owner=null, lease_until=null,
               run_after=q.dispatch_until, attempts=attempts-1
             from public.account_turn_queue q
             where ${fence} and j.generation=$4
               and q.sandbox_id=j.sandbox_id and q.request_id=$5 and q.state='dispatching'
               and isfinite(q.dispatch_until) and q.dispatch_until>clock_timestamp()
             returning j.id`,
            [...claimIdentity(job, owner), generation, requestId],
          );
          if (deferred.length) return true;
        }
        const { rows } = await db.query<{ completed: boolean }>(
          `select public.complete_job($1,$2,$3,$4,$5,
             case when $5 = 'failed' and evidence ? 'docker_actor_epoch'
                  then evidence || jsonb_build_object('reason', $8::text)
                  when $5 = 'failed' and kind = 'stop' then
                    (case when boat_stop then coalesce(evidence, '{}'::jsonb) else '{}'::jsonb end)
                       || jsonb_build_object('reason', $8::text)
                  when $5 = 'failed' then jsonb_build_object('reason', $8::text, 'evidence', evidence)
                  else evidence end, $7) as completed
           from (
             select kind, exists(select 1 from public.sandboxes s where s.id=jobs.sandbox_id and s.provider='boat') as boat_stop, case when kind = 'launch' and $6::jsonb is not null
                         then jsonb_build_object('result', $6::jsonb) ||
                           case when outcome->'modal_machine' is null then '{}'::jsonb
                                else jsonb_build_object('modal_machine', outcome->'modal_machine') end ||
                           case when $5 = 'queued' and outcome ? 'modal_handoff'
                                then jsonb_build_object('modal_handoff', outcome->'modal_handoff')
                                else '{}'::jsonb end ||
                           case when $5 = 'queued' and outcome ? 'boat_authority_sha256'
                                then jsonb_build_object('boat_authority_sha256', outcome->'boat_authority_sha256', 'boat_authority', outcome->'boat_authority')
                                else '{}'::jsonb end
                         when kind = 'launch' and $5 <> 'queued' and jsonb_typeof(outcome) = 'object'
                           then outcome - 'bootstrap_ticket_enc' - 'modal_handoff' - 'boat_authority_sha256'
                         when kind = 'resume' and outcome ? 'restoreDelivered' then
                           coalesce($6::jsonb, outcome) || jsonb_build_object('restoreDelivered', true)
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
          await result.commit?.(db);
        }
        return rows[0]?.completed === true;
      };
      if (job.kind === "turn_dispatch" || job.kind === "resume" || job.kind === "stop")
        return (await withLockedJobGeneration(job, owner, complete)) ?? false;
      if (result.commit || refundAttempt) {
        if (!sql.transaction) throw new Error("Job completion requires a transaction.");
        return sql.transaction(async (tx) => {
          if (job.kind === "launch" && job.sandbox_id && result.commit) {
            await tx.query("select id from public.sandboxes where id = $1 for update", [job.sandbox_id]);
          }
          return complete(tx, job.generation);
        });
      }
      return complete(sql, job.generation);
    },
  } satisfies JobStore & {
    enqueue: (...args: Parameters<typeof enqueueWithDisposition>) => Promise<string>;
    enqueueWithDisposition: typeof enqueueWithDisposition;
    modalLaunchJournal: (job: Job, createIfAuthorized?: AuthorizeJournalCreate) => ModalMachineJournal;
    modalFailedLaunchJournal: (
      job: Job,
      launchJobId: string,
      isCurrent: (tx: Sql) => Promise<boolean>,
      canDispatch: (tx: Sql) => Promise<boolean>,
    ) => ModalMachineJournal;
  };
}
