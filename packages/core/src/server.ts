/**
 * `@armada/core/server`: everything in the root entrypoint, plus the pieces that reach a node
 * builtin (a child process, the filesystem, `node:crypto`'s signing) and so can never be part of a
 * browser bundle. Only `packages/mcp-server` and `packages/cli` — both server-only — import this.
 * The dashboard (and anything else that ships to a browser) must import `@armada/core` instead.
 */

export { boatSnapshotName } from "./boat-snapshot-name.ts";
export {
  githubAppJwt,
  type InstallationToken,
  mintInstallationToken,
  revokeInstallationToken,
} from "./github-installation.ts";
export { createGoldenAdoption, type GoldenAdoption } from "./golden-adoption.ts";
export { GoldenBuildJobs, type GoldenBuildJobsOptions } from "./golden-build-jobs.ts";
export {
  assertGoldenBackendBinding,
  createGoldenCreateService,
  type GoldenCreateOptions,
  reserveGoldenBuild,
} from "./golden-create.ts";
export {
  type AuthorizedRepo,
  type GoldenCreateDeps,
  GoldenCreateService,
  goldenScript,
  type PreparedRepo,
  withGoldenDirs,
} from "./golden-create-service.ts";
export { type GoldenGitHubAdapterOptions, goldenGitHubAdapter } from "./golden-github.ts";
export { GITHUB_TOKEN_PATTERN, scanGoldenSandbox } from "./golden-scan.ts";
export * from "./golden-snapshot-retirement.ts";
export { assertSqlGoldenMutation } from "./golden-store.ts";
export * from "./index.ts";
export {
  type AuthorizeOrchestratorAccount,
  type DelegatedOrchestrator,
  type DelegatedRequest,
  newOrchestratorEpochSecret,
  OrchestratorAuthority,
  OrchestratorAuthorityDenied,
  type OrchestratorAuthorityTransport,
} from "./orchestrator-authority.ts";
export { reserveOrchestratorOperation } from "./orchestrator-operations.ts";
export {
  installPrivateSkill,
  PRIVATE_SKILL_FAILURES,
  PRIVATE_SKILL_PATTERN,
  PrivateSkillError,
} from "./private-skill.ts";
export { isNonMutatingProviderRefusal } from "./provider.ts";
export { sandboxActivity } from "./sandbox-activity.ts";
export * from "./skillpack.ts";
export {
  type SshExecDeps,
  shellQuote,
  sshHydrateAuthState,
  sshNativeAuthAdmission,
  sshPrivateAuthState,
  sshStdinCheckout,
} from "./ssh-executor.ts";
export { sshHydrateGitHubToken } from "./ssh-github-token.ts";
export { type PrivateOrchestratorSshReceipt, sshOrchestratorReceipt } from "./ssh-orchestrator.ts";
export { preserveWork, type WorkPreservation, workPreservationError } from "./work-preservation.ts";
