import { type AgentEvent, type PlanLimit, planLimitData, type Sql } from "@armada/core";

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
     on conflict(account_id) do update set account_version=excluded.account_version,
       code=excluded.code,resets_at=excluded.resets_at,event_at=excluded.event_at
     where (account_exhaustion.account_version,account_exhaustion.event_at)
       <= (excluded.account_version,excluded.event_at)`,
    [sandboxId, latest.limit.code, databaseReset, latest.at],
  );
}
