alter table public.sandboxes
  add column pull_request_source jsonb,
  add column pull_request_scan jsonb,
  add column pull_requests jsonb not null default '[]'::jsonb,
  add column pull_request_reports jsonb not null default '{}'::jsonb,
  add column pull_request_check_after timestamptz not null default now(),
  add column pull_request_merge_proof jsonb,
  add column stop_when_work_merged boolean not null default true;

create index sandboxes_pull_request_check_due
  on public.sandboxes(pull_request_check_after)
  where (status in ('ready', 'running') and stop_requested_at is null)
     or (status='stopped' and (pull_request_scan is not null or pull_request_reports<>'{}'::jsonb));

alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason in ('expired','idle_paused','agent_finished','work_merged'))
  or (status='deleted' and status_reason in ('retention_elapsed','disk_pressure'))
);

-- A verified merge stop commits before the runtime is irreversibly checkpointed.
alter table public.runtime_checkpoints add column merge_stop boolean not null default false;

update public.sandboxes
set pull_request_reports=jsonb_build_object(
  lifecycle_generation::text || ':' || coalesce(task_prompt_id,''), task_outcome)
where task_outcome->>'state'='ready' and (task_outcome ? 'prNumber' or task_outcome ? 'prUrl');

-- Dashboard reads: the detail row (RLS: owner or current admin) may read the confirmed
-- list, never the scan, reports or merge proof.
grant select(pull_requests) on public.sandboxes to authenticated;

-- The list RPC adds the confirmed list under the same interior rule as taskOutcome.
-- Its OUT columns change, so recreate it; shape otherwise unchanged from 20261114220000.
drop function public.sandbox_list_metadata();
create function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "taskOutcome" jsonb, "preservationNote" text, "displayLabel" text, "canOpen" boolean, "canManage" boolean, "idlePaused" boolean,
 "pullRequests" jsonb
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 case when (s.owner_id=m.user_id or m.role='admin') then s.task_outcome else null end,
 s.preservation_note, 'Sandbox ' || s.id::text,(s.owner_id=m.user_id or m.role='admin'),(s.owner_id=m.user_id or m.role='admin')
 , coalesce(s.status='stopped' and s.status_reason='idle_paused',false)
 , case when (s.owner_id=m.user_id or m.role='admin') then s.pull_requests else null end
 from public.sandboxes s
 join public.members m on m.org_id=s.org_id and m.user_id=(select auth.uid())
 where not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
