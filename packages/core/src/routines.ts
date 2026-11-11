/** A scheduled owner-scoped template launch definition. */
export interface Routine {
  id: string;
  orgId: string;
  ownerId: string;
  scope: "personal" | "org";
  name: string;
  templateId: string;
  templateRevision: number;
  prompt: string;
  intervalHours: number;
  maxRunsPerDay: number;
  ttlSeconds: number;
  status: "enabled" | "paused" | "deleted";
  nextDueAt: string | Date | null;
  consecutiveFailures: number;
  pauseReason: string | null;
  version: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export const ROUTINE_REASON_HELP = {
  previous_run_alive: "Skipped because the previous sandbox is still alive. Stop it before the next occurrence.",
  previous_run_uncertain: "Skipped because a previous launch is uncertain. Reconcile that launch before continuing.",
  daily_limit_reached: "Skipped because the rolling 24-hour launch limit was reached.",
  owner_authorization_changed: "The execution owner no longer has permission to run this routine.",
  launch_failed: "The template launch failed. Check owner access, credentials and template references.",
  launch_uncertain: "The launch outcome is uncertain. Its existing claim is retained; no replacement is launched.",
  repeated_launch_failures:
    "Automatically paused after three consecutive launch failures. Fix the cause before enabling.",
} as const;
/** Closed diagnostics only: never include a raw provider error in history. */
export function routineReasonHelp(reason: unknown): string | null {
  if (reason === null || reason === undefined) return null;
  return typeof reason === "string" && Object.hasOwn(ROUTINE_REASON_HELP, reason)
    ? ROUTINE_REASON_HELP[reason as keyof typeof ROUTINE_REASON_HELP]
    : "The routine could not launch. Check its owner access, template and run history.";
}
