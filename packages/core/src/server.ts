/**
 * `@armada/core/server`: everything in the root entrypoint, plus the pieces that reach a node
 * builtin (a child process, the filesystem, `node:crypto`'s signing) and so can never be part of a
 * browser bundle. Only `packages/mcp-server` and `packages/cli` — both server-only — import this.
 * The dashboard (and anything else that ships to a browser) must import `@armada/core` instead.
 */

export { type ApplicationVault, type ApplicationVaultActor, createApplicationVault } from "./application-vault.ts";
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
export { snapshotGolden } from "./golden-runtime.ts";
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
export {
  advanceRoutineSchedule,
  nextRoutineDates,
  parseRoutineSchedule,
  type RoutineSchedule,
} from "./routine-schedule.ts";
export {
  createRoutineScheduler,
  type RoutineLaunchAdmission,
  type RoutineSchedulerRuntime,
  type RoutineTaskState,
} from "./routine-scheduler.ts";
export { createRoutineService, type RoutineService } from "./routine-service.ts";
export { sandboxActivity } from "./sandbox-activity.ts";
export {
  type PriceContext,
  type PricedTurn,
  type PriceSnapshot,
  priceTurn,
  resolvePrice,
  type TokenRates,
} from "./server-pricing.ts";
export { createSkillCatalog } from "./skill-catalog.ts";
export * from "./skill-defaults.ts";
export { mergeSkillPins } from "./skill-merge.ts";
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
export { sshReadableVariables } from "./ssh-readable-variables.ts";
export { CAPTURE_MODEL_ENVIRONMENT, sshRepointCredentials } from "./ssh-repoint-credentials.ts";
export { createTemplateService, type TemplateRuntime, type TemplateService } from "./template-service.ts";
export { createSqlVaultStore } from "./vault-store.ts";
export { preserveWork, type WorkPreservation, workPreservationError } from "./work-preservation.ts";
