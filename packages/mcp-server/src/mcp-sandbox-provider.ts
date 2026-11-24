import type { Provider, ProviderRegistry, Sql } from "@armada/core/server";
import { type PersistedSandboxTargetRow, sandboxRowProviderTarget } from "./provider-sandbox-target.ts";

/** Resolves persisted source authority. Terminal access is read-only receipt observation. */
export function createMcpSandboxProviderResolver(
  sql: Sql,
  providers: ProviderRegistry,
  options: { terminalObservation?: boolean } = {},
) {
  return async (id: string): Promise<Provider> => {
    const row = (
      await sql.query<PersistedSandboxTargetRow>(
        `select s.id,s.runtime_transport,s.boat_runtime,s.provider::text as provider,s.org_id,s.owner_id,s.visibility::text as visibility,s.source_golden_visibility::text as source_golden_visibility,g.modal_workspace,g.modal_environment,g.modal_app_id
        from public.sandboxes s join public.goldens g on g.id=s.golden_id join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
        where s.id=$1::uuid and ($2::boolean or s.status not in ('stopped','deleted'))`,
        [id, options.terminalObservation === true],
      )
    ).rows[0];
    if (!row) throw Error("No authorized active sandbox for MCP lease renewal.");
    return providers.resolve(sandboxRowProviderTarget(row), { userId: row.owner_id });
  };
}
