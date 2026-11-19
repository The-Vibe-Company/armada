import { decryptSecret, encryptSecret, type Sql, toBytea } from "@armada/core/server";
import { deferTransactionWake, runtimeWakes } from "../wake-bus.ts";
import type { Job, JobStore } from "./runner.ts";

export const JOBS_WAKE = "jobs";

type JobRow = Omit<Job, "payload"> & { payload_enc: string | null };

const fence = "j.id = $1 and j.lease_owner = $2 and j.lease_epoch = $3 and j.lease_until > clock_timestamp()";
const claimKey = (job: Job, owner: string) => [job.id, owner, job.lease_epoch, job.generation];

interface EnqueueOptions {
  orgId: string;
  maxAttempts: number;
  deadline?: Date;
  request?: { ownerId: string; digest: string };
}

export function createJobsStore(sql: Sql, encryptionKey?: string) {
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
      const key = JSON.stringify([orgId, kind, request?.ownerId ?? null, idemKey]);
      const sealed = payload === null ? null : toBytea(await encryptSecret(JSON.stringify(payload), encryptionKey));
      const {
        rows: [inserted],
      } = await db.query<{ id: string }>(
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
      if (inserted) {
        if (!deferTransactionWake(db, JOBS_WAKE)) runtimeWakes.notify(JOBS_WAKE);
        return inserted.id;
      }
      const {
        rows: [existing],
      } = await db.query<{ id: string }>(
        `select id from public.jobs where idem_key = $1 and request_digest is not distinct from $2
           and ($2 is not null or (sandbox_id is not distinct from $3 and generation is not distinct from $4))`,
        [key, request?.digest ?? null, sandboxId, generation],
      );
      if (!existing) throw new Error("Conflicting job request.");
      return existing.id;
    },
    async claim(kind, owner, seconds, concurrency) {
      const {
        rows: [row],
      } = await sql.query<JobRow>(
        `select id, kind, sandbox_id, generation::text, lease_epoch::text, attempts, max_attempts, outcome,
                encode(payload_enc, 'hex') as payload_enc
         from public.claim_job($1,$2,$3,$4)`,
        [kind, owner, seconds, concurrency],
      );
      if (!row) return;
      const { payload_enc, ...job } = row;
      const payload =
        payload_enc === null
          ? null
          : JSON.parse(await decryptSecret(Uint8Array.from(Buffer.from(payload_enc, "hex")), encryptionKey));
      return { ...job, payload };
    },
    async inspect(job, owner) {
      const {
        rows: [row],
      } = await sql.query<{ state: "dispatch" | "reconcile" | "stale" }>(
        `select case when j.generation is not null and s.lifecycle_generation is distinct from j.generation
                       then 'stale'
                     when j.attempts > j.max_attempts or j.deadline_at <= clock_timestamp()
                       then 'reconcile'
                     else 'dispatch' end as state
         from public.jobs j left join public.sandboxes s on s.id = j.sandbox_id
         where ${fence} and j.generation is not distinct from $4`,
        claimKey(job, owner),
      );
      return row?.state ?? "lost";
    },
    async retireStale(job, owner) {
      if (!sql.transaction) throw new Error("Job retirement requires a transaction.");
      await sql.transaction(async (tx) => {
        const {
          rows: [sandbox],
        } = await tx.query<{ generation: string }>(
          "select lifecycle_generation::text as generation from public.sandboxes where id = $1 for update",
          [job.sandbox_id],
        );
        if (job.generation === null || sandbox?.generation === job.generation) return;
        await tx.query(
          `update public.jobs j set state = 'failed', lease_owner = null, lease_until = null,
             outcome = coalesce(outcome, '{}'::jsonb) || '{"reason":"stale_generation"}'::jsonb
           where ${fence} and j.generation = $4`,
          claimKey(job, owner),
        );
      });
    },
    async renew(job, owner, seconds) {
      const {
        rows: [row],
      } = await sql.query<{ renewed: boolean }>("select public.renew_job($1,$2,$3,$4,$5) as renewed", [
        ...claimKey(job, owner),
        seconds,
      ]);
      return row?.renewed === true;
    },
    async complete(job, owner, result) {
      const state = result.status === "retry" ? "queued" : result.status === "fail" ? "failed" : "done";
      const outcome = result.status === "fail" ? { reason: result.reason, evidence: result.outcome } : result.outcome;
      const complete = async (db: Sql) => {
        const {
          rows: [row],
        } = await db.query<{ completed: boolean }>(
          `select public.complete_job($1,$2,$3,$4,$5,
             coalesce($6::jsonb, (select outcome from public.jobs where id = $1)),$7) as completed`,
          [
            ...claimKey(job, owner),
            state,
            outcome === undefined ? null : JSON.stringify(outcome),
            result.status === "retry" ? result.after : null,
          ],
        );
        if (row?.completed) await result.commit?.(db);
      };
      if (result.commit) {
        if (!sql.transaction) throw new Error("Job completion requires a transaction.");
        await sql.transaction(complete);
      } else {
        await complete(sql);
      }
    },
  } satisfies JobStore & { enqueue: (...args: never[]) => Promise<string> };
}
