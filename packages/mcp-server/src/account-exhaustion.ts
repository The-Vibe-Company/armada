import { type AgentEvent, type PlanLimit, planLimitData, type Sql } from "@armada/core";

/** The enclosing runtime event transaction holds the sandbox and epoch locks. */
export async function recordAccountExhaustion(tx: Sql, sandboxId: string, events: readonly AgentEvent[]) {
  let latest: { at: number; limit: PlanLimit } | undefined;
  for (const event of events) {
    if (event.kind !== "other" || event.type !== "usage_limit" || !event.promptId) continue;
    const limit = planLimitData(event.data);
    if (limit && (!latest || event.at >= latest.at)) latest = { at: event.at, limit };
  }
  if (!latest) return;
  // Read the credential version without taking a credential lock. Admission
  // locks credentials before sandboxes. Readers must also match the version.
  await tx.query(
    `insert into public.account_exhaustion(account_id,credential_version,code,resets_at,event_at)
     select c.id,c.version,$2,$3,$4 from public.sandboxes s
     join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
     where s.id=$1
     on conflict(account_id) do update set credential_version=excluded.credential_version,
       code=excluded.code,resets_at=excluded.resets_at,event_at=excluded.event_at
     where (account_exhaustion.credential_version,account_exhaustion.event_at)
       <= (excluded.credential_version,excluded.event_at)`,
    [sandboxId, latest.limit.code, latest.limit.resetsAt ?? null, latest.at],
  );
}
