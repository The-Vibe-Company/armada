import type { GoldenRecord } from "./golden.ts";
import type { GitHubLaunchInfo, LaunchResult } from "./launch.ts";
import type { SandboxPlacementProviderId } from "./sandbox-provider.ts";

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

/** Shared flat launch metadata; callers retain their existing envelope-specific fields. */
export function launchResponse(result: LaunchResult) {
  const { sandbox } = result;
  return {
    id: sandbox.id,
    ...sandboxIdentity(sandbox),
    golden: result.golden.name,
    repositoryDir: sandbox.repositoryDir ?? null,
    harness: sandbox.harness,
    model: sandbox.model,
    skills: sandbox.skills ?? [],
    reasoningEffort: sandbox.reasoningEffort,
    credentialId: sandbox.credentialId ?? null,
    credentialVersion: sandbox.credentialVersion ?? null,
    status: sandbox.status,
    conversationIds: sandbox.conversationIds,
    promptId: result.promptId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt?.toISOString() ?? null,
    machineSize: sandbox.machineSize ?? null,
    github: launchGitHubResponse(result.github),
  };
}
