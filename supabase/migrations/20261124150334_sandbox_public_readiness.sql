begin;

-- Keep job and receipt data server-only. Only the projected status crosses the JWT boundary.
create function public.project_sandbox_status(
  sandbox_id uuid, org_id uuid, generation bigint, stored_status public.sandbox_status
) returns public.sandbox_status
language sql stable set search_path=public,pg_temp as $$
  select case when stored_status in ('ready','running') then coalesce(
    (select case setup.state
       when 'queued' then 'starting'::public.sandbox_status
       when 'leased' then 'starting'::public.sandbox_status
       when 'failed' then 'failed'::public.sandbox_status
     end
     from public.jobs setup
     where setup.idem_key=format('["internal","%s","launch_initial_turn","%s",%s,"%s"]',
       $2,$1,$3,$1)),
    (case when exists(
      select 1 from public.docker_launch_requests d where d.sandbox_id=$1 and d.result_enc is null
    ) then 'starting'::public.sandbox_status end),
    stored_status)
  else stored_status end
$$;
revoke all on function public.project_sandbox_status(uuid,uuid,bigint,public.sandbox_status)
  from public,anon,authenticated;
grant execute on function public.project_sandbox_status(uuid,uuid,bigint,public.sandbox_status) to service_role;

-- Detail uses interior visibility even for sandboxes excluded from inventory.
create function public.sandbox_detail_status(target_id uuid, target_org uuid)
returns public.sandbox_status
language sql stable security definer set search_path=public,pg_temp as $$
  select public.project_sandbox_status(s.id,s.org_id,s.lifecycle_generation,s.status)
  from public.sandboxes s
  where s.id=target_id and s.org_id=target_org and public.can_open_sandbox(s.org_id,s.owner_id)
$$;
revoke all on function public.sandbox_detail_status(uuid,uuid) from public,anon;
grant execute on function public.sandbox_detail_status(uuid,uuid) to authenticated;

create or replace function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "taskOutcome" jsonb, "preservationNote" text, "displayLabel" text, "canOpen" boolean, "canManage" boolean, "idlePaused" boolean,
 "pullRequests" jsonb
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 public.project_sandbox_status(s.id,s.org_id,s.lifecycle_generation,s.status)::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
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

commit;
