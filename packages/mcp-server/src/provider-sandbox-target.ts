import type { ProviderTarget, SandboxProviderId, Visibility } from "@armada/core/server";

export interface PersistedSandboxTargetRow {
  id: string;
  boat_runtime: boolean;
  runtime_transport: "dialout" | null;
  provider: SandboxProviderId;
  org_id: string;
  owner_id: string;
  visibility: Visibility;
  source_golden_visibility: Visibility;
  modal_workspace: string | null;
  modal_environment: string | null;
  modal_app_id: string | null;
}

/** Incomplete pinned metadata remains null so provider routing fails closed. */
export function sandboxRowModalBinding(row: {
  provider: string;
  modal_workspace?: string | null;
  modal_environment?: string | null;
  modal_app_id?: string | null;
}) {
  return row.provider === "modal" && row.modal_workspace && row.modal_environment && row.modal_app_id
    ? { workspace: row.modal_workspace, environment: row.modal_environment, appId: row.modal_app_id }
    : null;
}

/** Persisted metadata only; callers retain SQL visibility, membership and lifecycle admission. */
export function sandboxRowProviderTarget(row: PersistedSandboxTargetRow): ProviderTarget {
  return {
    id: row.id,
    ...(row.runtime_transport === "dialout" ? { runtimeTransport: "dialout" as const } : {}),
    ...(row.boat_runtime ? { boatRuntime: true as const } : {}),
    provider: row.provider,
    orgId: row.org_id,
    visibility: row.visibility,
    sourceGoldenVisibility: row.source_golden_visibility,
    modal: sandboxRowModalBinding(row),
  };
}
