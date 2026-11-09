import type { Sql } from "@armada/core";
import { refusal } from "./errors.ts";
import type { Scope } from "./ports.ts";
import { scopeKey } from "./store.ts";

/** The control plane alone supplies this context. Check all persisted identities on
 * every lease/save/read; a cleanup handle cannot allocate, switch machines or revive. */
export async function authorizeModalCleanup(
  sql: Sql,
  scope: Scope,
  sandboxId: string,
  generation?: string,
): Promise<void> {
  const c = scope.cleanup;
  if (
    !c ||
    c.providerSandboxId !== sandboxId ||
    (generation && c.physicalGeneration && generation !== c.physicalGeneration)
  )
    throw refusal("forbidden", "Cleanup identity mismatch.");
  const result = await sql.query(
    `select 1 from public.orchestrators o join public.sandboxes s on s.id=o.sandbox_id
     join public.modal_machines m on m.id=s.provider_sandbox_id
     where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3 and s.lifecycle_generation=$4
     and o.owner_id=$5 and o.org_id=$6 and s.owner_id=o.owner_id and s.org_id=o.org_id and s.provider='modal' and m.scope=$7 and m.owner_id=o.owner_id and m.org_id=o.org_id
     and ($8::text is null or m.record->>'generation'=$8)
     and (s.orchestrator_native_generation is null or m.record->>'generation'=s.orchestrator_native_generation)
     and ($9::uuid is null or exists(select 1 from public.orchestrator_operations p
       where p.id=$9 and p.orchestrator_id=o.id and p.action='stop' and p.revision=o.revision
       and p.state in ('pending','uncertain') and p.runtime_result->>'state'='uncertain'
       and p.runtime_result->>'sandboxId'=s.id::text and p.runtime_result->>'generation'=s.lifecycle_generation::text
       and (p.runtime_result->>'physicalGeneration' is null or p.runtime_result->>'physicalGeneration'=m.record->>'generation')))`,
    [
      c.orchestratorId,
      c.sandboxId,
      c.providerSandboxId,
      c.generation,
      scope.userId,
      scope.orgId,
      scopeKey(scope),
      c.physicalGeneration ?? generation ?? null,
      c.operationId ?? null,
    ],
  );
  if (!result.rows.length) throw refusal("forbidden", "Cleanup receipt or generation is fenced.");
}
/** Ingest is already authenticated by the exact expiring native runner grant.
 * Owner removal permits only draining the currently dispatched stop, not new work. */
export async function cleanupIngestAllowed(
  sql: Sql,
  scope: Scope,
  sandboxId: string,
  generation: string,
): Promise<boolean> {
  const result = await sql.query(
    `select 1 from public.orchestrators o join public.sandboxes s on s.id=o.sandbox_id
     join public.orchestrator_operations p on p.orchestrator_id=o.id
     where s.provider='modal' and s.provider_sandbox_id=$1 and o.owner_id=$2 and o.org_id=$3
     and s.orchestrator_native_generation=$4 and p.action='stop' and p.revision=o.revision
     and p.state in ('pending','uncertain') and p.runtime_result->>'state'='uncertain'
     and p.runtime_result->>'sandboxId'=s.id::text and p.runtime_result->>'generation'=s.lifecycle_generation::text
     and p.runtime_result->>'physicalGeneration'=$4`,
    [sandboxId, scope.userId, scope.orgId, generation],
  );
  return result.rows.length > 0;
}
