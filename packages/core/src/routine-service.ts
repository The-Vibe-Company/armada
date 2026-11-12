import type { ApplicationVaultActor } from "./application-vault.ts";
import type { Sql } from "./golden-store.ts";
import { cronForLegacyInterval } from "./routine-legacy-schedule.ts";
import { nextRoutineDates, parseRoutineSchedule } from "./routine-schedule.ts";
import { type Routine, routineReasonHelp } from "./routines.ts";
import { VaultError } from "./vault-error.ts";

type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  scope: "personal" | "org";
  name: string;
  template_id: string;
  template_revision: number;
  prompt: string;
  interval_hours: number | null;
  cron: string | null;
  timezone: string;
  max_runs_per_day: number;
  ttl_seconds: number;
  status: "enabled" | "paused" | "deleted";
  next_due_at: string | Date | null;
  consecutive_failures: number;
  pause_reason: string | null;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
};
function dto(r: Row): Routine {
  let description = `Every ${r.interval_hours} hours (legacy UTC timing; choose a cron to change it)`;
  if (r.cron) {
    try {
      description = parseRoutineSchedule(r.cron, r.timezone).description;
    } catch {
      description = "Schedule unavailable. Check its cron and time zone.";
    }
  }
  return {
    id: r.id,
    orgId: r.org_id,
    ownerId: r.owner_id,
    scope: r.scope,
    name: r.name,
    templateId: r.template_id,
    templateRevision: r.template_revision,
    prompt: r.prompt,
    intervalHours: r.interval_hours,
    cron: r.cron,
    timezone: r.timezone,
    scheduleDescription: description,
    maxRunsPerDay: r.max_runs_per_day,
    ttlSeconds: r.ttl_seconds,
    status: r.status,
    nextDueAt: r.next_due_at,
    consecutiveFailures: r.consecutive_failures,
    pauseReason: r.pause_reason,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function invalid(): never {
  throw new VaultError("invalid", "Invalid routine request.");
}
function id(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) invalid();
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0")) invalid();
  return v;
}
const configFields = [
  "name",
  "templateId",
  "templateRevision",
  "prompt",
  "intervalHours",
  "cron",
  "timezone",
  "maxRunsPerDay",
  "ttlSeconds",
];
/** Service-role writes, with current membership checks in the same transaction as each operation. */
export function createRoutineService(sql: Sql) {
  async function command(
    actor: ApplicationVaultActor,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, string[]> = {
      create: ["org", "scope", ...configFields],
      list: ["org"],
      get: ["org", "id"],
      update: ["org", "id", "expectedVersion", ...configFields],
      delete: ["org", "id", "expectedVersion"],
      enable: ["org", "id", "expectedVersion"],
      pause: ["org", "id", "expectedVersion"],
      history: ["org", "id"],
      preview: ["org", "cron", "timezone"],
    };
    if (!Object.hasOwn(fields, operation) || Object.keys(input).some((k) => !fields[operation]?.includes(k))) invalid();
    const org = id(input.org);
    if (!actor.orgs.some((o) => o.orgId === org)) throw new VaultError("forbidden", "Routine access denied.");
    if (!sql.transaction) throw new VaultError("unavailable", "Routine transactions unavailable.");
    try {
      return await sql.transaction(async (tx) => {
        const member = (
          await tx.query<{ role: string }>("select role from public.members where org_id=$1 and user_id=$2 for share", [
            org,
            actor.userId,
          ])
        ).rows[0];
        if (!member) throw new VaultError("forbidden", "Routine access denied.");
        const now = ["create", "update", "enable", "preview"].includes(operation)
          ? new Date((await tx.query<{ now: Date }>("select now() as now")).rows[0]!.now)
          : null;
        if (operation === "preview") {
          const schedule = parseRoutineSchedule(input.cron, input.timezone);
          return {
            ...schedule,
            nextRuns: nextRoutineDates(schedule, now!).map((d) => d.toISOString()),
            asOf: now!.toISOString(),
          };
        }
        if (operation === "list")
          return {
            items: (
              await tx.query<Row>(
                "select * from public.routines where org_id=$1 and (scope='org' or owner_id=$2) and status<>'deleted' order by name,id",
                [org, actor.userId],
              )
            ).rows.map(dto),
          };
        let current: Row | undefined;
        if (operation !== "create") {
          current = (
            await tx.query<Row>(
              "select * from public.routines where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) and (status<>'deleted' or $4::boolean) for update",
              [id(input.id), org, actor.userId, operation === "history"],
            )
          ).rows[0];
          if (!current) throw new VaultError("not_found", "Routine unavailable.");
          if (operation === "get") return { item: dto(current) };
          if (operation === "history") {
            const runs = await tx.query<{
              id: string;
              scheduled_due_at: string | Date;
              configuration_version: number;
              state: string;
              reason: string | null;
              missed_intervals: number;
              created_at: string | Date;
              updated_at: string | Date;
              sandbox_id: string | null;
              template_request_id: string | null;
              task_state: string | null;
              task_checked_at: string | Date | null;
              missed_count_capped: boolean;
            }>(
              `select r.id,r.scheduled_due_at,r.configuration_version,r.state,r.reason,r.template_request_id,r.task_state,r.task_checked_at,r.missed_count_capped,
                r.missed_intervals,r.created_at,r.updated_at,
                case when exists(select 1 from public.sandboxes s where s.id=r.sandbox_id
                  and s.org_id=$2 and s.owner_id=$3) then r.sandbox_id else null end as sandbox_id
                from public.routine_runs r where r.routine_id=$1
                order by r.scheduled_due_at desc,r.id desc limit 100`,
              [current.id, org, actor.userId],
            );
            return {
              items: runs.rows.map((r) => ({
                id: r.id,
                scheduledDueAt: r.scheduled_due_at,
                configurationVersion: r.configuration_version,
                state: r.state,
                reason: r.reason,
                reasonHelp: routineReasonHelp(r.reason),
                missedIntervals: r.missed_intervals,
                missedCountCapped: r.missed_count_capped,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                sandboxId: r.sandbox_id,
                templateRequestId: r.template_request_id,
                taskState: r.task_state,
                taskCheckedAt: r.task_checked_at,
                taskHelp:
                  r.task_state === "failed"
                    ? "The initial agent prompt failed. Inspect the authorized sandbox for details."
                    : r.task_state === "interrupted"
                      ? "The initial agent prompt was interrupted."
                      : r.task_state === "unknown"
                        ? "The initial prompt outcome could not be observed. No replacement is launched."
                        : null,
              })),
            };
          }
          if (current.version !== integer(input.expectedVersion, 1, 2147483647))
            throw new VaultError("conflict", "Routine version changed.");
        }
        const scope = current?.scope ?? input.scope;
        if (scope !== "personal" && scope !== "org") invalid();
        if (scope === "org" && member.role !== "admin")
          throw new VaultError("forbidden", "Routine administrator permission required.");
        if (operation === "delete") {
          const row = (
            await tx.query<Row>(
              "update public.routines set status='deleted',next_due_at=null,version=version+1,updated_at=now() where id=$1 returning *",
              [current!.id],
            )
          ).rows[0]!;
          return { item: dto(row), admittedRunsMayFinish: true };
        }
        if (operation === "pause") {
          const row = (
            await tx.query<Row>(
              "update public.routines set status='paused',next_due_at=null,pause_reason=null,version=version+1,updated_at=now() where id=$1 returning *",
              [current!.id],
            )
          ).rows[0]!;
          return { item: dto(row), admittedRunsMayFinish: true };
        }
        if (
          current &&
          !(
            await tx.query("select user_id from public.members where org_id=$1 and user_id=$2 for share", [
              org,
              current.owner_id,
            ])
          ).rows.length
        )
          throw new VaultError("conflict", "Routine owner is no longer an organization member.");
        if (operation === "enable") {
          const owner = (
            await tx.query<{ role: string }>(
              "select role from public.members where org_id=$1 and user_id=$2 for share",
              [org, current!.owner_id],
            )
          ).rows[0];
          if (!owner || (scope === "org" && owner.role !== "admin"))
            throw new VaultError("conflict", "Routine owner cannot run this routine.");
          const available = (
            await tx.query(
              `select t.id from public.launch_templates t
            join public.launch_template_revisions r on r.template_id=t.id and r.revision=$2
            where t.id=$1 and t.org_id=$3 and t.status='active' and (t.scope='org' or (t.owner_id=$4 and $5='personal')) for share of t`,
              [current!.template_id, current!.template_revision, org, current!.owner_id, scope],
            )
          ).rows[0];
          if (!available) throw new VaultError("not_found", "Routine template revision unavailable.");
          const next = current!.cron
            ? nextRoutineDates(parseRoutineSchedule(current!.cron, current!.timezone), now!, 1)[0]!
            : new Date(now!.getTime() + current!.interval_hours! * 3600000);
          const row = (
            await tx.query<Row>(
              "update public.routines set status='enabled',next_due_at=$2,consecutive_failures=0,pause_reason=null,version=version+1,updated_at=now() where id=$1 returning *",
              [current!.id, next],
            )
          ).rows[0]!;
          return { item: dto(row) };
        }
        const name = text(input.name, 200),
          templateId = id(input.templateId),
          revision = integer(input.templateRevision, 1, 2147483647);
        const prompt = text(input.prompt, 32000),
          max = integer(input.maxRunsPerDay === undefined && !current ? 24 : input.maxRunsPerDay, 1, 24),
          ttl = integer(input.ttlSeconds === undefined && !current ? 3600 : input.ttlSeconds, 300, 86400);
        let cron: string | null, timezone: string, interval: number | null;
        if (input.cron !== undefined || input.timezone !== undefined) {
          if (input.intervalHours !== undefined)
            throw new VaultError("invalid", "Use cron and timezone, not intervalHours with a cron schedule.");
          const schedule = parseRoutineSchedule(input.cron, input.timezone);
          cron = schedule.cron;
          timezone = schedule.timezone;
          interval = null;
        } else {
          interval = integer(input.intervalHours === undefined && !current ? 24 : input.intervalHours, 1, 720);
          if (current && current.interval_hours === interval) {
            cron = current.cron;
            timezone = current.timezone;
          } else {
            const schedule = cronForLegacyInterval(interval, new Date(now!.getTime() + interval * 3600000));
            // Additive rollout: the still-shipped v1 clients support arbitrary elapsed
            // hours. Preserve that contract until their cron controls are available.
            cron = schedule?.cron ?? null;
            timezone = schedule?.timezone ?? "UTC";
          }
        }
        const next =
          current?.status === "enabled"
            ? cron
              ? nextRoutineDates(parseRoutineSchedule(cron, timezone), now!, 1)[0]!
              : new Date(now!.getTime() + interval! * 3600000)
            : null;
        // An org routine must not turn an author's personal template into shared automation.
        const template = (
          await tx.query<{ id: string }>(
            `select t.id from public.launch_templates t join public.launch_template_revisions r on r.template_id=t.id and r.revision=$2
          where t.id=$1 and t.org_id=$3 and t.status='active' and (t.scope='org' or (t.owner_id=$4 and $5='personal')) for share of t`,
            [templateId, revision, org, actor.userId, scope],
          )
        ).rows[0];
        if (!template) throw new VaultError("not_found", "Routine template revision unavailable.");
        const params = [name, templateId, revision, prompt, interval, max, ttl, cron, timezone];
        const row = current
          ? (
              await tx.query<Row>(
                "update public.routines set name=$1,template_id=$2,template_revision=$3,prompt=$4,interval_hours=$5,max_runs_per_day=$6,ttl_seconds=$7,cron=$8,timezone=$9,next_due_at=$10,version=version+1,updated_at=now() where id=$11 returning *",
                [...params, next, current.id],
              )
            ).rows[0]!
          : (
              await tx.query<Row>(
                "insert into public.routines(name,template_id,template_revision,prompt,interval_hours,max_runs_per_day,ttl_seconds,cron,timezone,org_id,owner_id,scope) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *",
                [...params, org, actor.userId, scope],
              )
            ).rows[0]!;
        return { item: dto(row) };
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable", "Routine service unavailable.");
    }
  }
  return { command };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
