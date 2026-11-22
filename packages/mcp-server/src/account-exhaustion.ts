import { type AgentEvent, type PlanLimit, planLimitData, planLimitFromMessage, type Sql } from "@armada/core";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

const ACCOUNT_EXHAUSTION_UPSERT = `on conflict(account_id) do update set account_version=excluded.account_version,
  code=excluded.code,resets_at=excluded.resets_at,event_at=excluded.event_at
  where (account_exhaustion.account_version,account_exhaustion.event_at)
  <= (excluded.account_version,excluded.event_at)`;

export async function recordAccountExhaustion(tx: Sql, sandboxId: string, events: readonly AgentEvent[]) {
  let latest: { at: number; limit: PlanLimit } | undefined;
  for (const event of events) {
    if (event.kind !== "other" || event.type !== "usage_limit" || !event.promptId) continue;
    const limit = planLimitData(event.data);
    if (!limit) continue;
    if (limit.code === "rate_limited" && (!limit.resetsAt || Date.parse(limit.resetsAt) <= event.at)) continue;
    if (!latest || event.at >= latest.at) latest = { at: event.at, limit };
  }
  if (!latest) return;
  const reset = latest.limit.resetsAt;
  const databaseReset = reset?.startsWith("0000-") ? null : (reset ?? null);
  await tx.query(
    `insert into public.account_exhaustion(account_id,account_version,code,resets_at,event_at)
     select c.id,c.version,$2,$3,$4 from public.sandboxes s
     join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
     where s.id=$1
     ${ACCOUNT_EXHAUSTION_UPSERT}`,
    [sandboxId, latest.limit.code, databaseReset, latest.at],
  );
}

export async function recordNativeAccountExhaustion(
  sql: Sql,
  scope: readonly [string[], string],
  id: string,
  promptId: string,
  limit: PlanLimit & { resetsAt: string },
  at: number,
) {
  await sql.query(
    `insert into public.account_exhaustion(account_id,account_version,code,resets_at,event_at)
     select c.id,c.version,$5,$6,$7 from public.sandboxes s
     join public.sandbox_turn_models t on t.sandbox_id=s.id and t.prompt_id=$4
     join public.credentials c on c.id=(t.pricing_context->>'credentialId')::uuid
       and c.version::text=t.pricing_context->>'credentialVersion'
     where s.id=$3::uuid and ${SANDBOX_VISIBLE}
       and s.provider in ('boat','modal') and not s.boat_runtime and s.runtime_transport is null
     ${ACCOUNT_EXHAUSTION_UPSERT}`,
    [...scope, id, promptId, limit.code, limit.resetsAt, at],
  );
}

export function nativeExhaustionEvidence(
  events: readonly AgentEvent[],
  promptId: string,
  limit: PlanLimit,
  now: number,
) {
  if (!limit.resetsAt || limit.resetsAt.startsWith("0000-")) return;
  const reset = Date.parse(limit.resetsAt);
  if (!(reset > now)) return;
  let at = 0;
  for (const event of events) {
    if (event.promptId !== promptId || !Number.isSafeInteger(event.at) || event.at <= at || event.at >= reset) continue;
    const reported =
      event.kind === "other" && event.type === "usage_limit"
        ? planLimitData(event.data)
        : event.kind === "prompt" && event.status === "failed"
          ? (planLimitData(event.limit) ?? planLimitFromMessage(event.reason))
          : undefined;
    if (reported?.code === limit.code && reported.resetsAt === limit.resetsAt) at = event.at;
  }
  if (at) return { at, limit: { ...limit, resetsAt: limit.resetsAt } };
}
