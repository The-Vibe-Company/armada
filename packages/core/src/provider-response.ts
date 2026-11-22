import type { GoldenRecord } from "./golden.ts";
import type { GitHubLaunchInfo } from "./launch.ts";
import { SNAPSHOT_BASELINE_VERSION } from "./snapshot-baseline.ts";

/** Public golden metadata. */
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
    repos: row.config.repos.length,
    config: row.config,
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
