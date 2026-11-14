import type { Sql } from "@armada/core/server";
import { interviewAuthorization, type OttoInterviewScope } from "./interview.ts";

type DispatchResult = { status: "succeeded" | "unknown" | "pending"; result: unknown };
/** Persist and atomically claim before invoking an effect. A lost acknowledgement is never retried. */
export async function dispatchIntention(
  sql: Sql,
  scope: OttoInterviewScope,
  key: string,
  kind: string,
  payload: unknown,
  effect: () => Promise<unknown>,
): Promise<DispatchResult> {
  if (!key.trim() || !kind.trim()) throw new Error("Intention key and kind are required");
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Intention payload must be JSON");
  const params = [scope.orgId, scope.ownerId, scope.objectiveId, key, kind, serialized];
  await sql.query(
    `insert into public.otto_intentions(org_id,owner_id,objective_id,idempotency_key,kind,payload)
    select $1,$2,$3,$4,$5,$6::jsonb where ${interviewAuthorization}
    on conflict(objective_id,idempotency_key) do nothing`,
    params,
  );
  const row = (
    await sql.query<{ state: string; result: unknown; matches: boolean }>(
      `select state,result,(kind=$5 and payload=$6::jsonb) as matches from public.otto_intentions
    where org_id=$1 and owner_id=$2 and objective_id=$3 and idempotency_key=$4 and ${interviewAuthorization}`,
      params,
    )
  ).rows[0];
  if (!row) throw new Error("Intention objective unavailable");
  if (!row.matches) throw new Error("Idempotency key reused with different intention");
  if (row.state !== "pending")
    return { status: row.state === "succeeded" ? "succeeded" : "unknown", result: row.result };
  const claimed = (
    await sql.query<{ id: string }>(
      `update public.otto_intentions set state='dispatching',updated_at=now()
    where org_id=$1 and owner_id=$2 and objective_id=$3 and idempotency_key=$4 and kind=$5 and payload=$6::jsonb
      and state='pending' and ${interviewAuthorization} returning id`,
      params,
    )
  ).rows[0];
  if (!claimed) return { status: "unknown", result: null };
  let result: unknown;
  try {
    result = await effect();
    const encoded = JSON.stringify(result ?? null);
    await sql.query(
      `update public.otto_intentions set state='succeeded',result=$2::jsonb,updated_at=now() where id=$1 and state='dispatching'`,
      [claimed.id, encoded],
    );
  } catch {
    // The external service may have accepted the effect. Even a database error after
    // success leaves dispatching/unknown, not a retryable pending operation.
    await sql.query(
      `update public.otto_intentions set state='unknown',updated_at=now() where id=$1 and state='dispatching'`,
      [claimed.id],
    );
    return { status: "unknown", result: null };
  }
  return { status: "succeeded", result: result ?? null };
}
