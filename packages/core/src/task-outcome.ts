/** Explicit result of the latest finished turn; null means no report, not success. */
export type TaskOutcome =
  | { state: "ready"; prNumber?: number | undefined; prUrl?: string | undefined; headSha?: string | undefined }
  | { state: "blocked"; reason: string };
