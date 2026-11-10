-- Outcomes are sandbox interior: existing owner/admin RLS applies.
alter table public.sandboxes
  add column task_outcome jsonb,
  add column task_prompt_id text,
  add constraint sandboxes_task_outcome_check check (
    task_outcome is null or (
      task_prompt_id is not null and jsonb_typeof(task_outcome)='object' and
      case task_outcome->>'state'
        when 'ready' then
          task_outcome - array['state','prNumber','prUrl','headSha'] = '{}'::jsonb
          and (not task_outcome ? 'prNumber' or (
            jsonb_typeof(task_outcome->'prNumber')='number'
            and (task_outcome->>'prNumber')::numeric between 1 and 9007199254740991
            and (task_outcome->>'prNumber')::numeric = trunc((task_outcome->>'prNumber')::numeric)))
          and (not task_outcome ? 'prUrl' or (jsonb_typeof(task_outcome->'prUrl')='string' and length(task_outcome->>'prUrl') between 1 and 2048))
          and (not task_outcome ? 'headSha' or (jsonb_typeof(task_outcome->'headSha')='string' and task_outcome->>'headSha' ~ '^[a-fA-F0-9]{40}$'))
        when 'blocked' then
          task_outcome - array['state','reason'] = '{}'::jsonb
          and task_outcome ? 'reason'
          and jsonb_typeof(task_outcome->'reason')='string'
          and length(btrim(task_outcome->>'reason')) between 1 and 1000
        else false
      end
    )
  );
grant select(task_outcome,task_prompt_id) on public.sandboxes to authenticated;
-- Writes remain service-owned; user JWT cannot manufacture an outcome or turn receipt.

drop function public.sandbox_list_metadata();
create function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "taskOutcome" jsonb, "displayLabel" text, "canOpen" boolean, "canManage" boolean
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 case when public.can_open_sandbox(s.org_id,s.owner_id) then s.task_outcome else null end,
 'Sandbox ' || s.id::text,public.can_open_sandbox(s.org_id,s.owner_id),public.can_open_sandbox(s.org_id,s.owner_id)
 from public.sandboxes s
 where exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=auth.uid())
 and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
