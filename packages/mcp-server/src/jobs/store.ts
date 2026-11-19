import { decryptSecret, encryptSecret, type Sql, toBytea } from "@armada/core/server";
import { deferTransactionWake, runtimeWakes } from "../wake-bus.ts";
import type { Job, JobStore } from "./runner.ts";

export const JOBS_WAKE = "jobs";

type JobRow = Omit<Job, "payload"> & { payload_enc: string | null };

const fence = "j.id = $1 and j.lease_owner = $2 and j.lease_epoch = $3 and j.lease_until > clock_timestamp()";
const claimIdentity = (job: Job, owner: string) => [job.id, owner, job.lease_epoch];
const claimKey = (job: Job, owner: string) => [...claimIdentity(job, owner), job.generation];

export async function withJobLease<T>(sql: Sql, job: Job, write: (tx: Sql) => Promise<T>) {
  if (!sql.transaction) throw new Error("Job checkpoint requires a transaction.");
  return sql.transaction(async (tx) => {
    const { rows: sandboxes } = await tx.query(
      "select id from public.sandboxes where id=$1 and lifecycle_generation=$2 for update",
      [job.sandbox_id, job.generation],
    );
    if (!sandboxes.length) return;
    const { rows: jobs } = await tx.query(
      "select id from public.jobs where id=$1 and lease_epoch=$2 and lease_until > clock_timestamp() for update",
      [job.id, job.lease_epoch],
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
      return { ...job, payload };
    },
    async inspect(job, owner) {
      const { rows } = await sql.query<{ state: "dispatch" | "reconcile" | "stale" }>(
        `select case when j.generation is not null and s.lifecycle_generation is distinct from j.generation
                       then 'stale'
                     when j.attempts > j.max_attempts or j.deadline_at <= clock_timestamp()
                       then 'reconcile'
                     else 'dispatch' end as state
         from public.jobs j left join public.sandboxes s on s.id = j.sandbox_id
         where ${fence} and (j.kind = 'turn_dispatch' or j.generation is not distinct from $4)`,
        claimKey(job, owner),
      );
      return rows[0]?.state ?? "lost";
    },
    async retireStale(job, owner) {
      if (job.generation === null) return;
      if (!sql.transaction) throw new Error("Job retirement requires a transaction.");
      await sql.transaction(async (tx) => {
        const { rows: sandboxRows } = await tx.query<{ generation: string }>(
          "select lifecycle_generation::text as generation from public.sandboxes where id = $1 for update",
          [job.sandbox_id],
        );
        await tx.query(
          `update public.jobs j set state = 'failed', lease_owner = null, lease_until = null,
             outcome = coalesce(outcome, '{}'::jsonb) || '{"reason":"stale_generation"}'::jsonb
           where ${fence} and (j.kind = 'turn_dispatch' or j.generation = $4)
             and j.generation is distinct from $5`,
          [...claimKey(job, owner), sandboxRows[0]?.generation ?? null],
        );
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
          await handoff.advance(tx);
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
      const complete = async (db: Sql, generation: string | null) => {
        const { rows } = await db.query<{ completed: boolean }>(
          `select public.complete_job($1,$2,$3,$4,$5,
             case when $5 = 'failed' then jsonb_build_object('reason', $8::text, 'evidence', evidence)
                  else evidence end, $7) as completed
           from (select coalesce($6::jsonb, (select outcome from public.jobs where id = $1)) as evidence) data`,
          [
            ...claimIdentity(job, owner),
            generation,
            state,
            outcome,
            result.status === "retry" ? result.after : null,
            result.status === "fail" ? result.reason : null,
          ],
        );
        if (rows[0]?.completed) await result.commit?.(db);
        return rows[0]?.completed === true;
      };
      if (job.kind === "turn_dispatch") return (await withLockedTurnGeneration(job, owner, complete)) ?? false;
      if (result.commit) {
        if (!sql.transaction) throw new Error("Job completion requires a transaction.");
        return sql.transaction((tx) => complete(tx, job.generation));
      }
      return complete(sql, job.generation);
    },
  } satisfies JobStore & { enqueue: (...args: never[]) => Promise<string> };
}
