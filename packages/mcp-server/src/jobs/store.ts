import { decryptSecret, encryptSecret, type Sql, toBytea } from "@armada/core/server";
import type { ModalMachineJournal } from "@armada/provider-modal";
import {
  COMPLETED_RUNTIME_WAKE,
  CONFIRMED_WAKE_WITHOUT_TICKET,
  DISPATCH_ABANDONED,
  DISPATCHING_TURN_CANCELLED,
  ENROLLED_PENDING_RUNTIME_WAKE,
  failTurnReceipt,
  NATIVE_DISPATCH_UNCERTAIN,
  QUEUED_DISPATCH_EVIDENCE,
  QUEUED_TURN_CANCELLED,
  RUNTIME_LANE,
  resetAbandonedTurn,
} from "../account-turn-dispatch.ts";
import { deferTransactionWake, runtimeWakes } from "../wake-bus.ts";
import type { Job, JobStore } from "./runner.ts";

export const JOBS_WAKE = "jobs";

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

const CURRENT_DOCKER_RESUME_JOB = `(s.provider = 'docker' and exists(
  select 1 from public.docker_resume_claims c
  join public.docker_host_jobs h_job on h_job.request_id = c.request_id
    and h_job.bound_sandbox_id = c.sandbox_id and h_job.bound_actor_id = c.actor_id and h_job.host_id = c.host_id
  join public.docker_hosts h on h.id = c.host_id and h.org_id = s.org_id and h.installation_id = c.installation_id
  join public.members issuer on issuer.org_id = h.org_id and issuer.user_id = h.owner_id
  join public.members actor on actor.org_id = s.org_id and actor.user_id = c.actor_id
  join public.mcp_actor_epochs a on a.org_id = actor.org_id and a.user_id = actor.user_id
  where c.request_id = q.request_id and c.sandbox_id = s.id and c.actor_id = s.owner_id and c.actor_id = q.owner_id
    and c.host_id = s.docker_host_id and c.installation_id = s.docker_installation_id
    and c.generation = s.docker_generation and c.accepted
    and c.lifecycle_generation = q.dispatch_generation and c.lifecycle_generation + 1 = s.lifecycle_generation
    and h_job.bound_operation = 'resume' and h_job.bound_actor_epoch = a.epoch
    and h_job.cancelled_at is null and h_job.refused_resume_generation is null
    and (h_job.outcome = 'completed' or (h_job.outcome is null and s.status = 'starting'))
    and h.hash is not null and h.registration_hash is null and h.revoked_at is null
    and not exists(select 1 from public.runtime_commands p
      where p.sandbox_id = s.id and p.request_id = 'docker_prompt_' || q.request_id::text)
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

// WARNING: Only call inside a fenced job completion after requeueing the job.
export async function rescheduleRecurringJob(tx: Sql, job: Job, after: Date) {
  await tx.query("update public.jobs set attempts=0,run_after=$2 where id=$1", [job.id, after]);
}

interface EnqueueOptions {
  orgId: string;
  maxAttempts: number;
  deadline?: Date;
  request?: { ownerId: string; digest: string };
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
          abandoned: boolean;
          unrecoverable_dispatch: boolean;
          open_dispatch_until: string | null;
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
                    or (${ADJACENT_RUNTIME_DISPATCH} and s.status in ('ready','running')
                      and (q.dispatch_until is null or q.dispatch_until <= statement_timestamp())
                      and ${NO_ADJACENT_DISPATCH_EVIDENCE}))) as unrecoverable_dispatch,
                  case when ${ADJACENT_RUNTIME_DISPATCH}
                    and ((s.status in ('ready','running')
                      and (s.provider in ('boat','modal') or ${NO_ADJACENT_DISPATCH_EVIDENCE}
                        or (s.activity_lease_id is null and ${CURRENT_DOCKER_PROMPT_COMMAND})))
                      or (s.status in ('starting','ready','running')
                        and s.activity_lease_id is null and ${CURRENT_DOCKER_RESUME_JOB}))
                    and isfinite(q.dispatch_until) and q.dispatch_until > statement_timestamp()
                    then q.dispatch_until::text end as open_dispatch_until
           from public.sandboxes s join public.account_turn_queue q on q.sandbox_id = s.id
           where s.id = $1 and q.request_id = $2`,
          [sandboxId, requestId, job.generation],
        );
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
                     or ${CONFIRMED_WAKE_WITHOUT_TICKET} or (q.dispatch_until <= clock_timestamp()
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
        if (retiring && sandbox?.open_dispatch_until) {
          const { rows } = await tx.query(
            `update public.jobs j set state = 'queued', lease_owner = null, lease_until = null, run_after = $4,
               attempts = case when $6::boolean then j.attempts - 1 else j.attempts end
             where ${fence} and j.generation < $5 returning j.id`,
            [...claimIdentity(job, owner), sandbox.open_dispatch_until, sandbox.generation, phase === "no_dispatch"],
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
      | "native_dispatch_uncertain" = "stale_generation",
  ) {
    const { rows } = await tx.query(
      `update public.jobs j set state = 'failed', lease_owner = null, lease_until = null,
         outcome = coalesce(outcome, '{}'::jsonb) || jsonb_build_object('reason', $6::text)
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

  return {
    modalLaunchJournal(job: Job, canCreate?: (tx: Sql) => Promise<boolean>) {
      if (job.kind !== "launch" || !job.sandbox_id || !job.generation) {
        throw new Error("Modal machine journal requires a launch claim.");
      }
      return {
        async read(key) {
          const checkpoint = await withJobLease(sql, job, async (tx) => {
            const { rows } = await tx.query<{
              checkpoint: { key: string; entry: Awaited<ReturnType<ModalMachineJournal["read"]>> } | null;
            }>(
              "select outcome->'modal_machine' as checkpoint from public.jobs where id=$1 and lease_until > clock_timestamp()",
              [job.id],
            );
            return rows[0]?.checkpoint;
          });
          if (checkpoint === undefined) throw new Error("Modal launch claim is no longer current.");
          if (checkpoint && checkpoint.key !== key) throw new Error("Modal launch journal key changed.");
          return checkpoint?.entry;
        },
        async compareAndSet(key, revision, next) {
          if (next.revision !== (revision ?? 0) + 1) return false;
          return (
            (await withJobLease(sql, job, async (tx) => {
              if (next.phase === "creating" && revision === undefined && canCreate && !(await canCreate(tx)))
                return false;
              const { rows } = await tx.query(
                `update public.jobs set outcome=jsonb_set(
                   case when outcome is null then '{}'::jsonb
                        when jsonb_typeof(outcome) = 'object' then outcome
                        else jsonb_build_object('result', outcome) end,
                   '{modal_machine}', $2::jsonb)
                 where id=$1 and lease_until > clock_timestamp()
                   and (outcome->'modal_machine' is null or outcome->'modal_machine'->>'key' = $3)
                   and (outcome->'modal_machine'->'entry'->>'revision')::integer is not distinct from $4::integer
                 returning id`,
                [job.id, JSON.stringify({ key, entry: next }), key, revision ?? null],
              );
              return rows.length > 0;
            })) ?? false
          );
        },
      } satisfies ModalMachineJournal;
    },
    async enqueue(
      kind: string,
      sandboxId: string | null,
      generation: number | null,
      idemKey: string,
      payload: unknown,
      options: EnqueueOptions,
      tx?: Sql,
    ) {
      const db = tx ?? sql;
      const { orgId, request, deadline, maxAttempts } = options;
      const key = JSON.stringify(
        request
          ? ["request", orgId, kind, request.ownerId, idemKey]
          : ["internal", orgId, kind, sandboxId, generation, idemKey],
      );
      const serialized = JSON.stringify(payload);
      if (serialized === undefined) throw new Error("Job payload must be JSON.");
      const sealed = payload === null ? null : toBytea(await encryptSecret(serialized, encryptionKey));
      const { rows: insertedRows } = await db.query<{ id: string }>(
        `insert into public.jobs
           (kind, sandbox_id, generation, idem_key, payload_enc, org_id, max_attempts, deadline_at,
            request_owner_id, request_digest)
         values ($1,$2,$3,$4,$5::text::bytea,$6,$7,$8,$9,$10)
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
        ],
      );
      if (insertedRows[0]) {
        if (!deferTransactionWake(db, JOBS_WAKE)) {
          if (!tx || tx === sql) runtimeWakes.notify(JOBS_WAKE);
          else await tx.transaction?.(async (raw) => deferTransactionWake(raw, JOBS_WAKE));
        }
        return insertedRows[0].id;
      }
      const { rows: existingRows } = await db.query<{ id: string }>(
        `select id from public.jobs where idem_key = $1 and request_digest is not distinct from $2`,
        [key, request?.digest ?? null],
      );
      if (!existingRows[0]) throw new Error("Conflicting job request.");
      return existingRows[0].id;
    },
    async claim(kind, owner, seconds, concurrency) {
      const { rows } = await sql.query<JobRow>(
        `select id, kind, sandbox_id, generation::text, lease_epoch::text, attempts, max_attempts, outcome,
                encode(payload_enc, 'hex') as payload_enc
         from public.claim_job($1,$2,$3,$4)`,
        [kind, owner, seconds, concurrency],
      );
      if (!rows[0]) return;
      const { payload_enc, ...job } = rows[0];
      const payload =
        payload_enc === null
          ? null
          : JSON.parse(await decryptSecret(Uint8Array.from(Buffer.from(payload_enc, "hex")), encryptionKey));
      const claimed = { ...job, payload };
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
                                else jsonb_build_object('modal_machine', outcome->'modal_machine') end
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
      if (job.kind === "turn_dispatch") return (await withLockedTurnGeneration(job, owner, complete)) ?? false;
      if (result.commit || refundAttempt) {
        if (!sql.transaction) throw new Error("Job completion requires a transaction.");
        return sql.transaction((tx) => complete(tx, job.generation));
      }
      return complete(sql, job.generation);
    },
  } satisfies JobStore & {
    enqueue: (...args: never[]) => Promise<string>;
    modalLaunchJournal: (job: Job, canCreate?: (tx: Sql) => Promise<boolean>) => ModalMachineJournal;
  };
}
