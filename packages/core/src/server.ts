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
export * from "./golden-adoption.ts";
export * from "./golden-build-jobs.ts";
export { assertGoldenBackendBinding, createGoldenCreateService, type GoldenCreateOptions } from "./golden-create.ts";
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
export * from "./index.ts";
export { type SshExecDeps, shellQuote, sshStdinCheckout } from "./ssh-executor.ts";
