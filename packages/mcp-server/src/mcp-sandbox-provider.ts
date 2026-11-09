import type { Provider, ProviderRegistry, SandboxProviderId, Sql, Visibility } from "@armada/core/server";

/** Resolves an active sandbox's persisted target and source authority for server-owned MCP renewal. */
export function createMcpSandboxProviderResolver(sql: Sql, providers: ProviderRegistry) {
  return async (id: string): Promise<Provider> => {
    const row = (
      await sql.query<{
        provider: SandboxProviderId;
        org_id: string;
        owner_id: string;
        visibility: Visibility;
        source_golden_visibility: Visibility;
        modal_workspace: string | null;
        modal_environment: string | null;
        modal_app_id: string | null;
      }>(
        `select s.provider::text as provider,s.org_id,s.owner_id,s.visibility::text as visibility,s.source_golden_visibility::text as source_golden_visibility,g.modal_workspace,g.modal_environment,g.modal_app_id
        from public.sandboxes s join public.goldens g on g.id=s.golden_id join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
        where s.id=$1::uuid and s.status not in ('stopped','deleted')`,
        [id],
      )
    ).rows[0];
    if (!row) throw Error("No authorized active sandbox for MCP lease renewal.");
    const modal =
      row.provider === "modal" && row.modal_workspace && row.modal_environment && row.modal_app_id
        ? { workspace: row.modal_workspace, environment: row.modal_environment, appId: row.modal_app_id }
        : null;
    return providers.resolve(
      {
        provider: row.provider,
        orgId: row.org_id,
        visibility: row.visibility,
        sourceGoldenVisibility: row.source_golden_visibility,
        modal,
      },
      { userId: row.owner_id },
    );
  };
}
