import type { AgentEvent, Provider, Sql } from "@armada/core/server";
import type { ManagedMachine } from "./orchestrator-managed-runtime.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

/** Checkpoint ACK means the native outbox is durable. Copy its complete ordered
 * history before publishing stopped; neither owner polling nor membership is required.
 * This private lane is bound to the already-dispatched stop receipt, not a user read. */
export async function mirrorStoppedHistory(
  sql: Sql,
  provider: Provider,
  machine: ManagedMachine,
  operationId: string,
  conversationId: string | null,
): Promise<void> {
  if (!conversationId) return;
  if (!machine.physicalGeneration) throw new OrchestratorRuntimeError("conflict");
  if (!sql.transaction) throw new OrchestratorRuntimeError("unavailable");
  const initial = (
    await sql.query<{ provider_cursor: string | null }>(
      `select provider_cursor from public.orchestrator_runtime where orchestrator_id=$1`,
      [machine.orchestratorId],
    )
  ).rows[0];
  if (!initial) throw new OrchestratorRuntimeError("conflict");
  let cursor: string | undefined = initial.provider_cursor ?? undefined;
  const events: AgentEvent[] = [];
  for (;;) {
    const page = await provider.events({
      sandboxId: machine.providerSandboxId,
      conversationId,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const event of page.events) {
      if (event.conversationId !== conversationId) throw new OrchestratorRuntimeError("conflict");
      events.push(event);
    }
    if (!page.hasMore) {
      cursor = page.cursor ?? cursor;
      break;
    }
    if (!page.cursor || page.cursor === cursor) throw new OrchestratorRuntimeError("conflict");
    cursor = page.cursor;
  }
  await sql.transaction(async (tx) => {
    const bound = await tx.query<{ revision: string }>(
      `select o.revision from public.orchestrators o join public.sandboxes s on s.id=o.sandbox_id
       join public.orchestrator_operations p on p.orchestrator_id=o.id
       join public.orchestrator_runtime r on r.orchestrator_id=o.id
       where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3 and s.lifecycle_generation=$4
       and s.orchestrator_native_generation=$7 and r.conversation_id=$6
       and r.provider_cursor is not distinct from $8::text
       and p.id=$5 and p.action='stop' and p.revision=o.revision and p.state in ('pending','uncertain')
       and p.runtime_result->>'state'='uncertain' and p.runtime_result->>'physicalGeneration'=$7
       and p.runtime_result->>'sandboxId'=s.id::text and p.runtime_result->>'generation'=s.lifecycle_generation::text for update of o,s,p,r`,
      [
        machine.orchestratorId,
        machine.sandboxId,
        machine.providerSandboxId,
        machine.generation,
        operationId,
        conversationId,
        machine.physicalGeneration,
        initial.provider_cursor,
      ],
    );
    if (!bound.rows[0]) throw new OrchestratorRuntimeError("conflict");
    for (const event of events)
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,generation,conversation_id,upstream_id,event)
       select $1,$2,$3,$4,$5,$6::jsonb where not exists(
         select 1 from public.orchestrator_runtime_events where orchestrator_id=$1 and conversation_id=$4 and upstream_id=$5
       ) on conflict(orchestrator_id,generation,conversation_id,upstream_id) do nothing`,
        [
          machine.orchestratorId,
          bound.rows[0].revision,
          machine.generation,
          conversationId,
          event.id,
          JSON.stringify({ kind: "agent", event }),
        ],
      );
    await tx.query(`update public.orchestrator_runtime set provider_cursor=$2 where orchestrator_id=$1`, [
      machine.orchestratorId,
      cursor ?? null,
    ]);
  });
}
