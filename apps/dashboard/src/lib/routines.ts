import { ROUTINE_REASON_HELP, type Routine, routineReasonHelp } from "@armada/core";
import type { TemplateHeader } from "./templates.ts";

export type RoutineItem = Omit<Routine, "createdAt" | "updatedAt" | "nextDueAt"> & {
  createdAt: string;
  updatedAt: string;
  nextDueAt: string | null;
};
export type RoutineRun = {
  id: string;
  scheduledDueAt: string;
  configurationVersion: number;
  state: "admitted" | "succeeded" | "failed" | "reconciling" | "skipped";
  reason: string | null;
  taskState: "running" | "finished" | "failed" | "interrupted" | "unknown" | null;
  sandboxId: string | null;
  templateRequestId: string | null;
  missedIntervals: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string";
const id = (x: unknown): x is string => text(x) && uuid.test(x);
const int = (x: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
const date = (x: unknown): x is string => text(x) && Number.isFinite(Date.parse(x));
const reason = (x: unknown): string | null =>
  x == null ? null : text(x) && Object.hasOwn(ROUTINE_REASON_HELP, x) ? x : "unknown";
export function parseRoutine(x: unknown): RoutineItem | null {
  if (
    !record(x) ||
    !id(x.id) ||
    !id(x.orgId) ||
    !id(x.ownerId) ||
    !id(x.templateId) ||
    !text(x.name) ||
    !text(x.prompt) ||
    !text(x.scope) ||
    !["personal", "org"].includes(x.scope) ||
    !text(x.status) ||
    !["enabled", "paused", "deleted"].includes(x.status) ||
    !int(x.templateRevision) ||
    !int(x.version) ||
    !int(x.intervalHours, 1, 720) ||
    !int(x.ttlSeconds, 300, 86400) ||
    !int(x.maxRunsPerDay, 1, 24) ||
    !int(x.consecutiveFailures, 0) ||
    !date(x.createdAt) ||
    !date(x.updatedAt) ||
    (x.nextDueAt !== null && !date(x.nextDueAt))
  )
    return null;
  return {
    id: x.id,
    orgId: x.orgId,
    ownerId: x.ownerId,
    templateId: x.templateId,
    name: x.name,
    prompt: x.prompt,
    scope: x.scope as RoutineItem["scope"],
    status: x.status as RoutineItem["status"],
    templateRevision: x.templateRevision,
    version: x.version,
    intervalHours: x.intervalHours,
    ttlSeconds: x.ttlSeconds,
    maxRunsPerDay: x.maxRunsPerDay,
    consecutiveFailures: x.consecutiveFailures,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    nextDueAt: x.nextDueAt,
    pauseReason: reason(x.pauseReason),
  };
}
export function parseRoutineRun(x: unknown): RoutineRun | null {
  if (
    !record(x) ||
    !id(x.id) ||
    !date(x.scheduledDueAt) ||
    !int(x.configurationVersion) ||
    !int(x.missedIntervals, 0) ||
    !text(x.state) ||
    !["admitted", "succeeded", "failed", "reconciling", "skipped"].includes(x.state) ||
    (x.sandboxId !== null && !id(x.sandboxId)) ||
    (x.templateRequestId !== null && !id(x.templateRequestId)) ||
    (x.taskState !== null &&
      (!text(x.taskState) || !["running", "finished", "failed", "interrupted", "unknown"].includes(x.taskState)))
  )
    return null;
  return {
    id: x.id,
    scheduledDueAt: x.scheduledDueAt,
    configurationVersion: x.configurationVersion,
    missedIntervals: x.missedIntervals,
    state: x.state as RoutineRun["state"],
    reason: reason(x.reason),
    taskState: x.taskState as RoutineRun["taskState"],
    sandboxId: x.sandboxId,
    templateRequestId: x.templateRequestId,
  };
}
export function canManageRoutine(
  item: Pick<RoutineItem, "scope" | "ownerId">,
  viewer: { userId: string; admin: boolean },
) {
  return item.scope === "org" ? viewer.admin : item.ownerId === viewer.userId;
}
export const intervalLabel = (hours: number) => `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
export function routineFailure(status?: number): string {
  if (status === 400) return "Check the template revision, prompt and schedule limits.";
  if (status === 401) return "Sign in again before managing routines.";
  if (status === 403)
    return "Your access changed. Only an owner manages personal routines; organization routines require an admin.";
  if (status === 404) return "This routine or template revision is no longer available. Refresh the page.";
  if (status === 409) return "This routine or its references changed. Refresh the page before trying again.";
  return "Routines are unavailable. Refresh to check the saved state before trying again.";
}
export function runDescription(run: RoutineRun): string {
  return (
    routineReasonHelp(run.reason) ??
    (run.state === "succeeded"
      ? "Sandbox launched. Agent outcome is shown separately."
      : run.state === "admitted"
        ? "Launch admitted; waiting for its receipt."
        : "The launch outcome is not yet confirmed.")
  );
}
export type RoutineInput = {
  name: string;
  scope: "personal" | "org";
  templateId: string;
  templateRevision: number;
  prompt: string;
  intervalHours: number;
  ttlSeconds: number;
  maxRunsPerDay: number;
};
export function routineRequest(
  fields: Record<string, string>,
  templates: readonly Pick<TemplateHeader, "id" | "scope" | "currentRevision">[],
): { ok: true; value: RoutineInput } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const name = fields.name?.trim() ?? "",
    prompt = fields.prompt ?? "";
  if (!name || name.length > 200 || name.includes("\0")) return bad("Give the routine a name (up to 200 characters).");
  if (!prompt.trim() || prompt.length > 32000 || prompt.includes("\0"))
    return bad("Write a prompt (up to 32,000 characters). Do not include secrets.");
  if (fields.scope !== "personal" && fields.scope !== "org") return bad("Choose personal or organization visibility.");
  const template = templates.find((x) => x.id === fields.template);
  const revision = Number(fields.revision),
    interval = Number(fields.interval),
    ttl = Number(fields.ttl),
    cap = Number(fields.cap);
  if (!template || !int(revision) || revision !== template.currentRevision)
    return bad("That template revision changed or is unavailable. Refresh the page.");
  if (fields.scope === "org" && template.scope !== "org")
    return bad("Organization routines require an organization template.");
  if (!int(interval, 1, 720)) return bad("Use a whole-hour interval between 1 and 720 hours.");
  if (!int(ttl, 5, 1440)) return bad("Choose a sandbox lifetime between 5 and 1,440 minutes.");
  if (!int(cap, 1, 24)) return bad("Use a daily cap between 1 and 24 launches.");
  return {
    ok: true,
    value: {
      name,
      scope: fields.scope,
      templateId: template.id,
      templateRevision: revision,
      prompt,
      intervalHours: interval,
      ttlSeconds: ttl * 60,
      maxRunsPerDay: cap,
    },
  };
}
