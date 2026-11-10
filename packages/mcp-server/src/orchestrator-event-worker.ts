import type { Sql } from "@armada/core/server";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import { orchestratorRuntimeOperations } from "./orchestrator-runtime-operation.ts";

/** Boat has no Runner push channel. Consume its durable cursor even when no owner
 * is polling. Multiple servers may read the same page; the journal CAS deduplicates
 * both history and activity. A fair sweep cannot be monopolized by one busy parent. */
export function createOrchestratorEventWorker(sql: Sql, runtime: OrchestratorRuntime) {
  const operations = orchestratorRuntimeOperations();
  let after = "";
  let stopped = false;
  return {
    drain: operations.drain,
    stopAdmission() {
      stopped = true;
    },
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (stopped) return false;
      signal.throwIfAborted();
      const row = (
        await sql.query<{ id: string; owner_id: string; org_id: string }>(
          `select o.id,o.owner_id,o.org_id from public.orchestrators o
         join public.orchestrator_runtime r on r.orchestrator_id=o.id
         join public.sandboxes s on s.id=o.sandbox_id
         join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
         where o.state='ready' and s.provider='boat' and s.stop_requested_at is null
         and r.conversation_id is not null and o.id::text>$1 order by o.id limit 1`,
          [after],
        )
      ).rows[0];
      if (!row) {
        after = "";
        return false;
      }
      after = row.id;
      await operations.run(() => runtime.collectEvents(row.owner_id, row.org_id, row.id, signal), signal);
      // One page per scheduler tick. Do not spin indefinitely over empty pages.
      return false;
    },
  };
}
