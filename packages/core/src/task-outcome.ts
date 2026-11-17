/** Explicit result of the latest finished turn; null means no report, not success. */
export type TaskOutcome =
  | { state: "ready"; prNumber?: number | undefined; prUrl?: string | undefined; headSha?: string | undefined }
  | { state: "blocked"; reason: string };

/** GitHub-confirmed pull request associated with a sandbox's work. */
export interface SandboxPullRequest {
  repository: string;
  number: number;
  url: string;
  headBranch: string;
  state: "open" | "merged" | "closed";
  checkedAt: string;
}
