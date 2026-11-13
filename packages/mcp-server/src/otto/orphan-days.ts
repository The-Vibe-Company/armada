import type { OttoOrphan, OttoResource } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import type { OttoScope } from "./observation.ts";
import { type OrphanDayRow, readOttoSnapshot } from "./snapshot.ts";

/** Detections survive recovery; daily history is not an invented first-seen time. */
export async function orphanDays(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  resources: OttoResource[],
  complete: boolean,
  now: Date,
  day: string,
  supplied?: OrphanDayRow[],
) {
  const rows = [...(supplied ?? (await readOttoSnapshot(sql, scope, caller, day)).history)];
  if (day === now.toISOString().slice(0, 10)) {
    for (const r of resources.filter(isOrphan)) {
      if (
        !rows.some(
          (row) => row.resource.kind === r.kind && row.resource.externalId === r.externalId && row.reason === r.reason,
        )
      )
        rows.push({ resource: r, reason: r.reason, first_seen_at: now.toISOString(), last_seen_at: now.toISOString() });
    }
  }
  return rows.map((row) => {
    const current = resources.find((r) => r.kind === row.resource.kind && r.externalId === row.resource.externalId);
    const stillOrphan =
      current?.reason === row.reason &&
      (current.owner.state === "orphan" ||
        ["idle_owner_needs_work", "live_sandbox_without_task_or_pr"].includes(current.reason));
    const knownResolved =
      current &&
      ((row.reason === "pr_without_live_owner" &&
        current.owner.state === "owned" &&
        ["live", "idle"].includes(current.activity?.state ?? "")) ||
        (row.reason === "idle_owner_needs_work" &&
          (current.owner.state === "orphan" || current.activity?.state === "live" || current.needsWork === "false")) ||
        (row.reason === "live_sandbox_without_task_or_pr" &&
          (current.taskIssue !== null ||
            current.reason === "sandbox_task_link" ||
            current.activity?.state === "not_live")));
    return {
      resource: row.resource,
      state: "orphan",
      reason: row.reason,
      day,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      current: row.retired
        ? false
        : stillOrphan
          ? true
          : knownResolved || (!current && complete && row.resource.kind === "pr")
            ? false
            : null,
    } satisfies OttoOrphan;
  });
}

function isOrphan(r: OttoResource) {
  return (
    r.owner.state === "orphan" || r.reason === "idle_owner_needs_work" || r.reason === "live_sandbox_without_task_or_pr"
  );
}

/** Only the observation worker persists detections; HTTP reads never acquire write locks. */
export async function recordOrphanDays(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  resources: OttoResource[],
  now: Date,
) {
  const today = now.toISOString().slice(0, 10);
  for (const r of resources.filter(
    (r) =>
      r.owner.state === "orphan" ||
      r.reason === "idle_owner_needs_work" ||
      r.reason === "live_sandbox_without_task_or_pr",
  )) {
    await sql.query(
      `insert into public.otto_orphan_days(org_id,repository,observer_id,day,kind,external_id,reason,first_seen_at,last_seen_at,resource)
   values($1,$2,$3,$4,$5,$6,$7,$8,$8,$9::jsonb)
   on conflict(org_id,repository,observer_id,day,kind,external_id,reason) do update set last_seen_at=greatest(otto_orphan_days.last_seen_at,excluded.last_seen_at),resource=case when excluded.last_seen_at>=otto_orphan_days.last_seen_at then excluded.resource else otto_orphan_days.resource end`,
      [
        scope.orgId,
        scope.repository,
        caller.userId,
        today,
        r.kind,
        r.externalId,
        r.reason,
        now.toISOString(),
        JSON.stringify(r),
      ],
    );
  }
}
