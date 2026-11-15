import type { Provider, ProviderRegistry, Sql } from "@armada/core/server";
import { type PersistedSandboxTargetRow, sandboxRowProviderTarget } from "./provider-sandbox-target.ts";

/** Resolves an active sandbox's persisted target and source authority for server-owned MCP renewal. */
export function createMcpSandboxProviderResolver(sql: Sql, providers: ProviderRegistry) {
  return async (id: string): Promise<Provider> => {
    const row = (
      await sql.query<PersistedSandboxTargetRow>(
        `select s.id,s.runtime_transport,s.boat_runtime,s.provider::text as provider,s.org_id,s.owner_id,s.visibility::text as visibility,s.source_golden_visibility::text as source_golden_visibility,g.modal_workspace,g.modal_environment,g.modal_app_id
        from public.sandboxes s join public.goldens g on g.id=s.golden_id join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
        where s.id=$1::uuid and s.status not in ('stopped','deleted')`,
        [id],
      )
    ).rows[0];
    if (!row) throw Error("No authorized active sandbox for MCP lease renewal.");
    return providers.resolve(sandboxRowProviderTarget(row), { userId: row.owner_id });
  };
}

/** Resolve a persisted binding's immutable management target for native transition.
 * This read performs no lifecycle writes; the caller observes the provider.
 * SQL terminal labels are not physical-state proof or an admission fence. */
export function createHistoricalSandboxProviderResolver(providers: ProviderRegistry) {
  return async (sql: Sql, id: string): Promise<{ provider: Provider; providerSandboxId: string }> => {
    const row = (
      await sql.query<PersistedSandboxTargetRow & { provider_sandbox_id: string | null }>(
        `select s.id,s.runtime_transport,s.boat_runtime,s.provider::text as provider,s.provider_sandbox_id,s.org_id,s.owner_id,
       coalesce(s.visibility,g.visibility)::text as visibility,
       coalesce(s.source_golden_visibility,g.visibility)::text as source_golden_visibility,
       g.modal_workspace,g.modal_environment,g.modal_app_id
       from public.sandboxes s join public.goldens g on g.id=s.golden_id
       join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       where s.id=$1::uuid`,
        [id],
      )
    ).rows[0];
    if (!row?.provider_sandbox_id) throw Error("Historical native binding cannot be observed.");
    const provider = await providers.resolve(sandboxRowProviderTarget(row), { userId: row.owner_id });
    if (provider.id !== row.provider) throw Error("Historical native provider binding changed.");
    return { provider, providerSandboxId: row.provider_sandbox_id };
  };
}
