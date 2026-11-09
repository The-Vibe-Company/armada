import type { Sql } from "./golden-store.ts";

/** Reserve before external effects. Caller identity is authenticated owner, never guest-supplied.
 * Row lock serializes concurrent requests; retries return the original durable receipt. */
export async function reserveOrchestratorOperation(
  sql: Sql,
  input: {
    orchestratorId: string;
    actorId: string;
    action: "create" | "message" | "steer" | "stop" | "resume";
    key: string;
    digest: string;
    expectedRevision: number;
  },
): Promise<{ id: string; revision: number; state: string }> {
  if (
    !sql.transaction ||
    !/^[ -~]{1,128}$/.test(input.key) ||
    !/^[a-f0-9]{64}$/.test(input.digest) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw new Error("Invalid orchestrator operation.");
  return sql.transaction(async (tx) => {
    const parent = await tx.query<{ revision: string | number }>(
      `select o.revision from public.orchestrators o
      join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
      where o.id=$1 and o.owner_id=$2 for update of o,m`,
      [input.orchestratorId, input.actorId],
    );
    if (!parent.rows[0]) throw new Error("No such orchestrator.");
    const prior = await tx.query<{ id: string; revision: number; state: string; request_digest: string }>(
      `select id,revision,state,request_digest from public.orchestrator_operations
       where orchestrator_id=$1 and actor_id=$2 and action=$3 and idempotency_key=$4`,
      [input.orchestratorId, input.actorId, input.action, input.key],
    );
    const receipt = prior.rows[0];
    if (receipt) {
      if (receipt.request_digest !== input.digest) throw new Error("Idempotency conflict.");
      return { id: receipt.id, revision: Number(receipt.revision), state: receipt.state };
    }
    if (Number(parent.rows[0].revision) !== input.expectedRevision) throw new Error("Stale orchestrator revision.");
    const revision = input.expectedRevision + 1;
    const result = await tx.query<{ id: string; revision: number; state: string }>(
      `insert into public.orchestrator_operations
      (orchestrator_id,actor_id,action,idempotency_key,request_digest,revision) values($1,$2,$3,$4,$5,$6)
      returning id,revision,state`,
      [input.orchestratorId, input.actorId, input.action, input.key, input.digest, revision],
    );
    await tx.query("update public.orchestrators set revision=$2 where id=$1", [input.orchestratorId, revision]);
    const row = result.rows[0];
    if (!row) throw new Error("Operation reservation failed.");
    return { id: row.id, revision: Number(row.revision), state: row.state };
  });
}
