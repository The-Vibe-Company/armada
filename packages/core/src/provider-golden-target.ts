import type { GoldenRow } from "./golden-store.ts";
import type { ProviderTarget, SandboxProviderId } from "./sandbox-provider.ts";

/** Immutable routing metadata only; authorization/provenance remains with the caller. */
export function goldenRowProviderTarget(
  row: Pick<
    GoldenRow,
    "provider" | "org_id" | "owner_id" | "visibility" | "modal_workspace" | "modal_environment" | "modal_app_id"
  >,
): ProviderTarget & { ownerId: string } {
  return {
    provider: row.provider as SandboxProviderId,
    orgId: row.org_id,
    ownerId: row.owner_id,
    visibility: row.visibility as "org" | "private",
    modal:
      row.provider === "modal"
        ? { workspace: row.modal_workspace!, environment: row.modal_environment!, appId: row.modal_app_id! }
        : null,
  };
}
