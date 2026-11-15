import { type AgentEvent, type MemberRole, reportedTurnUsage, type Sql } from "@armada/core";
import { type Scope, scopeKey } from "@armada/provider-modal";
import { createSqlData } from "./data.ts";
import { runtimeTransaction } from "./runtime-enrolment.ts";

/** Tunnel and dial-out events use the same native-counter extraction and persisted usage recorder.
 * Called under the authenticated Modal generation/archive transaction, never from a status read. */
export async function projectModalEventUsage(
  tx: Sql,
  scope: Scope,
  physicalId: string,
  events: AgentEvent[],
): Promise<void> {
  const usage = reportedTurnUsage(events);
  if (!usage.turnCount && !usage.turns.length) return;
  const target = (
    await tx.query<{ id: string; role: MemberRole }>(
      `select s.id,m.role from public.sandboxes s join public.members m
      on m.org_id=s.org_id and m.user_id=s.owner_id
      where s.provider='modal' and s.provider_sandbox_id=$1 and s.org_id=$2 and s.owner_id=$3`,
      [physicalId, scope.orgId, scope.userId],
    )
  ).rows[0];
  // Do not ACK measured usage before its public launch exists: the producer must retry it.
  // Golden-builder/control-only prompt events have no public session to update.
  if (!target) {
    if (usage.turns.length) throw Error("modal_usage_target_unavailable");
    return;
  }
  usage.turnCount = Number(
    (
      await tx.query<{ count: string }>(
        `select count(distinct event->>'promptId')::text as count from public.modal_events
      where scope=$1 and sandbox_id=$2 and event->>'promptId' is not null`,
        [scopeKey(scope), physicalId],
      )
    ).rows[0]?.count ?? "0",
  );
  // Preserve transaction-aware pricing; do not take recordUsage's query-only legacy fallback.
  const store = createSqlData(runtimeTransaction(tx))({
    userId: scope.userId,
    orgs: [{ orgId: scope.orgId, role: target.role }],
    via: "service",
  }).sandboxes;
  await store.recordUsage!(target.id, usage, { observations: usage.turns });
}
