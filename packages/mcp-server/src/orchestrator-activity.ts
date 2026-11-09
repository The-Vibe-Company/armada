import type { AgentEvent, Sql } from "@armada/core/server";
import { lifecycleNow, type OrchestratorMachine } from "./orchestrator-lifecycle-contract.ts";

/** Called by the trusted #662 journal consumer, never by a public heartbeat endpoint.
 * Accepts actual normalized Provider events; raw text/tool input/output is NOT persisted here.
 * Journal identity deduplication prevents log polling/replays from resetting the idle clock. */
export async function recordOrchestratorActivity(
  sql: Sql,
  machine: OrchestratorMachine,
  event: AgentEvent,
  clock?: () => Date,
): Promise<boolean> {
  if (!sql.transaction) throw new Error("Transactional orchestrator activity required.");
  if (!event.id || !event.promptId || !event.conversationId) return false;
  const meaningful =
    event.kind === "prompt" ||
    event.kind === "steer" ||
    (event.kind === "message" && (event.text.length > 0 || event.tools.length > 0));
  if (!meaningful) return false;
  const now = await lifecycleNow(sql, clock);
  return sql.transaction(async (tx) => {
    const parent = (
      await tx.query(
        `select o.id from public.orchestrators o
      join public.sandboxes s on s.id=o.sandbox_id
      where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3 and s.lifecycle_generation=$4
      and o.state='ready' and s.stop_requested_at is null for update of o,s`,
        [machine.orchestratorId, machine.sandboxId, machine.providerSandboxId, machine.generation],
      )
    ).rows[0];
    if (!parent) return false;
    const inserted = await tx.query(
      `insert into public.orchestrator_activity
      (orchestrator_id,sandbox_id,parent_generation,event_id,prompt_id,conversation_id,observed_at)
      values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning event_id`,
      [
        machine.orchestratorId,
        machine.sandboxId,
        machine.generation,
        event.id,
        event.promptId,
        event.conversationId,
        now,
      ],
    );
    if (!inserted.rows.length) return false;
    await tx.query(
      `insert into public.orchestrator_lifecycle(orchestrator_id,last_activity_at,reason)
      values($1,$2,'native_activity') on conflict(orchestrator_id) do update set
      last_activity_at=$2,observation_state='unknown',reason='native_activity',reconcile_after=$2`,
      [machine.orchestratorId, now],
    );
    return true;
  });
}
