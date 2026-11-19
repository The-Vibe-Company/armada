import type { GoldenRecord } from "./golden.ts";
import type { GitHubLaunchInfo } from "./launch.ts";
import type { SandboxPlacementProviderId } from "./sandbox-provider.ts";
import { SNAPSHOT_BASELINE_VERSION } from "./snapshot-baseline.ts";

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
    baselineVersion: row.baselineVersion ?? null,
    baselineOutdated: row.providerSnapshotId !== null && (row.baselineVersion ?? 0) < SNAPSHOT_BASELINE_VERSION,
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

export function sandboxIdentity<P extends SandboxPlacementProviderId>(row: { provider: P; providerSandboxId: string }) {
  return {
    provider: row.provider,
    providerSandboxId: row.providerSandboxId,
    boatId: row.provider === "boat" ? row.providerSandboxId : null,
  };
}

export function launchGitHubResponse(github: GitHubLaunchInfo) {
  return {
    status: github.status,
    login: github.login ?? null,
    tokenExpiresAt: github.tokenExpiresAt ?? null,
    message: github.message ?? null,
  };
}
