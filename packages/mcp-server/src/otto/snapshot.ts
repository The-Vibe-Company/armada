import type { AgentEvent, OttoResource } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import type { FleetSandbox } from "./fleet.ts";
import type { OttoScope } from "./observation.ts";
import type { OwnershipFact } from "./ownership.ts";

export const FLEET_LIMIT = 100;
export interface FleetRow extends FleetSandbox {
  modal_events: (AgentEvent | null)[];
  runtime_events: (string | null)[];
}
export interface OrphanDayRow {
  retired?: boolean;
  resource: OttoResource;
  reason: string;
  first_seen_at: string;
  last_seen_at: string;
}
export interface OttoSnapshot {
  facts: OwnershipFact[];
  fleet: FleetRow[];
  restricted: boolean;
  capped: boolean;
  history: OrphanDayRow[];
  historyCapped: boolean;
}

/** One statement, with indexed active-only admission before any journal access. */
export async function readOttoSnapshot(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  day: string,
  key?: string,
): Promise<OttoSnapshot> {
  const result = await sql.query<OttoSnapshot>(
    `
with candidates as materialized (
 select s.* from public.sandboxes s where s.org_id=$1 and s.deleted_at is null
 and s.status not in ('stopped','deleted','failed') and (s.visibility='org' or s.access_owner_id=$3)
 order by s.id limit 101
), fleet as materialized (
 select s.id,s.owner_id,s.access_owner_id,s.visibility,s.provider,s.provider_sandbox_id,s.status,s.last_observed_at,s.deleted_at,s.task_prompt_id,
 case when s.owner_id=$3 or $4 then s.task_outcome else null end as task_outcome,
 s.resource_project,g.modal_workspace,g.modal_environment,g.modal_app_id,
 encode(sha256(convert_to(concat('[',to_json(s.org_id::text),',',to_json(s.visibility::text),',',case when s.visibility='private' then to_json(s.access_owner_id::text)::text else 'null' end,',',to_json(g.modal_workspace),',',to_json(g.modal_environment),',',to_json(g.modal_app_id),']'),'UTF8')),'hex') as modal_scope
 from candidates s join public.goldens g on g.id=s.golden_id order by s.id limit 100
), facts as materialized (
 select * from (select f.*,row_number() over(partition by subject,kind order by observed_at desc,id desc) as rank from
 (select distinct on(subject,kind,coalesce(evidence->'head'->>'sha','')) *,min(observed_at) over(partition by subject,kind,coalesce(evidence->'head'->>'sha','')) as head_first_seen_at
 from public.otto_facts where org_id=$1 and repository=$2 order by subject,kind,coalesce(evidence->'head'->>'sha',''),observed_at desc,id desc) f) ranked where rank<=2
 order by subject,kind,observed_at desc,id desc limit 2001
), history as materialized (
 select d.resource,d.reason,d.first_seen_at,d.last_seen_at,
 exists(select 1 from public.sandboxes s where s.id=case when d.kind='sandbox' then d.external_id::uuid end
 and s.org_id=d.org_id and (s.deleted_at is not null or s.status in ('stopped','deleted','failed'))) as retired
 from public.otto_orphan_days d
 where d.org_id=$1 and d.repository=$2 and d.observer_id=$3 and d.day=$5
 and (d.resource#>>'{owner,sandboxId}' is null or exists(select 1 from public.sandboxes s where s.id=(d.resource#>>'{owner,sandboxId}')::uuid and s.org_id=d.org_id and (s.visibility='org' or s.access_owner_id=$3)))
 and (d.kind='pr' or exists(select 1 from public.sandboxes s where s.id=d.external_id::uuid and s.org_id=d.org_id and (s.visibility='org' or s.access_owner_id=$3)))
 order by d.kind,d.external_id,d.reason limit 1001
)
select coalesce((select jsonb_agg(to_jsonb(f)) from facts f),'[]'::jsonb) as facts,
 coalesce((select jsonb_agg(to_jsonb(f) || jsonb_build_object(
  'modal_events',coalesce((select jsonb_agg(e.event order by e.cursor desc) from (
    select cursor,case when octet_length(event::text)<=65536 then event else null end as event
    from public.modal_events where f.provider='modal' and scope=f.modal_scope and sandbox_id=f.provider_sandbox_id
    and event->>'kind' in ('prompt','message') order by cursor desc limit 128) e),'[]'::jsonb),
  'runtime_events',coalesce((select jsonb_agg(e.event_hex order by e.sequence desc) from (
    select sequence,case when octet_length(event_enc)<=65536 then encode(event_enc,'hex') else null end as event_hex
    from public.runtime_events where $6::boolean and f.provider='boat' and sandbox_id=f.id order by sequence desc limit 128) e),'[]'::jsonb)
 )) from fleet f),'[]'::jsonb) as fleet,
 ((select count(*) from candidates)>100 or (select count(*) from facts)>2000) as capped,
 exists(select 1 from public.sandboxes s where s.org_id=$1 and s.deleted_at is null and s.status not in ('stopped','deleted','failed') and s.visibility='private' and s.access_owner_id<>$3 limit 1) as restricted,
 coalesce((select jsonb_agg(to_jsonb(h)) from history h),'[]'::jsonb) as history,
 (select count(*)>1000 from history) as "historyCapped"
`,
    [
      scope.orgId,
      scope.repository,
      caller.userId,
      caller.orgs.some((o) => o.orgId === scope.orgId && o.role === "admin"),
      day,
      !!key,
    ],
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw Error("otto_snapshot_missing");
  snapshot.facts = snapshot.facts.slice(0, 2000);
  snapshot.history = snapshot.history.slice(0, 1000);
  return snapshot;
}
