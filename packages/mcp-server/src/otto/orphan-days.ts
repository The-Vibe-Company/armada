import type { OttoOrphan, OttoResource } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import type { OttoScope } from "./observation.ts";

/** Detections survive recovery; daily history is not an invented first-seen time. */
export async function orphanDays(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  resources: OttoResource[],
  complete: boolean,
  now: Date,
  day: string,
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
  const rows = (
    await sql.query<{ resource: OttoResource; reason: string; first_seen_at: string; last_seen_at: string }>(
      `select d.resource,d.reason,d.first_seen_at,d.last_seen_at from public.otto_orphan_days d
 where d.org_id=$1 and d.repository=$2 and d.observer_id=$3 and d.day=$4
 and (d.resource#>>'{owner,sandboxId}' is null or exists(select 1 from public.sandboxes s where s.id::text=d.resource#>>'{owner,sandboxId}' and s.org_id=d.org_id and (s.visibility='org' or s.access_owner_id=$3)))
 and (d.kind='pr' or exists(select 1 from public.sandboxes s where s.id::text=d.external_id and s.org_id=d.org_id and (s.visibility='org' or s.access_owner_id=$3)))
 order by d.kind,d.external_id,d.reason`,
      [scope.orgId, scope.repository, caller.userId, day],
    )
  ).rows;
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
      current: stillOrphan
        ? true
        : knownResolved || (!current && complete && row.resource.kind === "pr")
          ? false
          : null,
    } satisfies OttoOrphan;
  });
}
