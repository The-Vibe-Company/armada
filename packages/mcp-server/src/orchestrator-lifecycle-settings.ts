import { createHash } from "node:crypto";
import type { Sql } from "@armada/core/server";
import { lifecycleNow, OrchestratorLifecycleError } from "./orchestrator-lifecycle-contract.ts";

/** Trusted authenticated owner API composition. No public caller-chosen owner identity.
 * NULL child limit is intentionally unlimited; no synthetic quota/start defaults. */
export async function configureOrchestratorLifecycle(
  sql: Sql,
  input: {
    key: string;
    orchestratorId: string;
    ownerId: string;
    expectedRevision: number;
    idleSeconds: number;
    maxActiveChildren: number | null;
  },
  clock?: () => Date,
): Promise<void> {
  if (
    !sql.transaction ||
    !/^[ -~]{1,128}$/.test(input.key) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !Number.isSafeInteger(input.idleSeconds) ||
    input.idleSeconds < 900 ||
    input.idleSeconds > 86400 ||
    (input.maxActiveChildren !== null &&
      (!Number.isSafeInteger(input.maxActiveChildren) || input.maxActiveChildren < 1))
  )
    throw new OrchestratorLifecycleError("invalid_request", "Invalid lifecycle policy.");
  const now = await lifecycleNow(sql, clock);
  const digest = createHash("sha256")
    .update(JSON.stringify([input.expectedRevision, input.idleSeconds, input.maxActiveChildren]))
    .digest("hex");
  await sql.transaction(async (tx) => {
    const parent = (
      await tx.query<{ revision: string }>(
        `select o.id,o.revision from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where o.id=$1 and o.owner_id=$2 and o.state not in ('stopping','resuming') for update of o,m`,
        [input.orchestratorId, input.ownerId],
      )
    ).rows[0];
    if (!parent) throw new OrchestratorLifecycleError("not_found", "Stale or unavailable orchestrator.");
    const prior = (
      await tx.query<{ request_digest: string }>(
        `select request_digest from public.orchestrator_lifecycle_mutations
      where orchestrator_id=$1 and actor_id=$2 and action='configure' and target='policy' and idempotency_key=$3`,
        [input.orchestratorId, input.ownerId, input.key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_digest !== digest) throw new OrchestratorLifecycleError("conflict", "Idempotency conflict.");
      return;
    }
    if (Number(parent.revision) !== input.expectedRevision)
      throw new OrchestratorLifecycleError("conflict", "Stale orchestrator revision.");
    if (
      (
        await tx.query(
          `select id from public.orchestrator_operations where orchestrator_id=$1 and state in ('pending','uncertain')`,
          [input.orchestratorId],
        )
      ).rows.length
    )
      throw new OrchestratorLifecycleError("conflict", "Orchestrator owner operation is busy.");
    await tx.query(
      `insert into public.orchestrator_lifecycle(orchestrator_id,idle_seconds,max_active_children,last_activity_at,reconcile_after)
      values($1,$2,$3,$4,$4) on conflict(orchestrator_id) do update set idle_seconds=$2,max_active_children=$3,reconcile_after=$4`,
      [input.orchestratorId, input.idleSeconds, input.maxActiveChildren, now],
    );
    await tx.query("update public.orchestrators set revision=revision+1 where id=$1", [input.orchestratorId]);
    await tx.query(
      `insert into public.orchestrator_lifecycle_mutations
      (orchestrator_id,actor_id,action,target,idempotency_key,request_digest,result)
      values($1,$2,'configure','policy',$3,$4,'{}'::jsonb)`,
      [input.orchestratorId, input.ownerId, input.key, digest],
    );
  });
}
