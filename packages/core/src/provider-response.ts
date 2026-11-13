import type { GoldenRecord } from "./golden.ts";

/** Public golden metadata only; compatibility aliases never borrow another placement's ids. */
export function goldenResponse(row: GoldenRecord) {
  return {
    id: row.id,
    name: row.name,
    orgId: row.orgId,
    visibility: row.visibility,
    ownerId: row.ownerId,
    provider: row.provider,
    providerSnapshotId: row.providerSnapshotId,
    providerSandboxId: row.providerSandboxId,
    modal: row.modal,
    ...goldenCompatibilityIds(row),
    repos: row.config.repos.length,
    config: row.config,
  };
}

export function goldenCompatibilityIds(row: GoldenRecord) {
  const boat = row.provider === "boat";
  return {
    boatSnapshotId: boat ? row.providerSnapshotId : null,
    boatSandboxId: boat ? row.providerSandboxId : null,
  };
}
