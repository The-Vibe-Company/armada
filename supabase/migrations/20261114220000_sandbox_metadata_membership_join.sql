-- Resolve current membership once per joined row instead of three security-definer
-- point lookups per sandbox. The members primary key prevents duplicate metadata.
-- Keep the RPC shape, grants, orchestrator exclusion and interior masking unchanged.
create or replace function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "taskOutcome" jsonb, "preservationNote" text, "displayLabel" text, "canOpen" boolean, "canManage" boolean, "idlePaused" boolean
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 case when (s.owner_id=m.user_id or m.role='admin') then s.task_outcome else null end,
 s.preservation_note, 'Sandbox ' || s.id::text,(s.owner_id=m.user_id or m.role='admin'),(s.owner_id=m.user_id or m.role='admin')
 , coalesce(s.status='stopped' and s.status_reason='idle_paused',false)
 from public.sandboxes s
 join public.members m on m.org_id=s.org_id and m.user_id=(select auth.uid())
 where not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
