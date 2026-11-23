import { encryptSecret, type Sql, toBytea } from "@armada/core/server";
import { deferTransactionWake, runtimeWakes } from "../wake-bus.ts";

export const JOBS_WAKE = "jobs";

export function jobRequestKey(orgId: string, kind: string, ownerId: string, key: string) {
  return JSON.stringify(["request", orgId, kind, ownerId, key]);
}

export class ConflictingJobRequest extends Error {
  constructor() {
    super("Conflicting job request.");
  }
}

interface EnqueueOptions {
  orgId: string;
  maxAttempts: number;
  deadline?: Date;
  initialOutcome?: Record<string, unknown>;
  request?: { ownerId: string; digest: string };
}

export function createJobsEnqueue(sql: Sql, encryptionKey?: string) {
  return async function enqueue(
    kind: string,
    sandboxId: string | null,
    generation: number | null,
    idemKey: string,
    payload: unknown,
    options: EnqueueOptions,
    tx?: Sql,
  ) {
    const db = tx ?? sql;
    const { orgId, request, deadline, maxAttempts, initialOutcome } = options;
    const key = request
      ? jobRequestKey(orgId, kind, request.ownerId, idemKey)
      : JSON.stringify(["internal", orgId, kind, sandboxId, generation, idemKey]);
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("Job payload must be JSON.");
    const sealed = payload === null ? null : toBytea(await encryptSecret(serialized, encryptionKey));
    const { rows: insertedRows } = await db.query<{ id: string }>(
      `insert into public.jobs
           (kind, sandbox_id, generation, idem_key, payload_enc, org_id, max_attempts, deadline_at,
            request_owner_id, request_digest, outcome)
         values ($1,$2,$3,$4,$5::text::bytea,$6,$7,$8,$9,$10,$11::jsonb)
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
        initialOutcome ? JSON.stringify(initialOutcome) : null,
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
    if (!existingRows[0]) throw new ConflictingJobRequest();
    return existingRows[0].id;
  };
}
