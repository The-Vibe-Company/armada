-- Preserve existing diagnostics/expiry rules while adding the idle checkpoint stop reason.
alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason in ('expired','idle_paused'))
);
comment on column public.sandboxes.status_reason is 'Failure diagnostic, expired lifetime stop, or idle_paused checkpointed stop.';

-- Additive, non-secret idle-pause classification; preserve owner/admin interior masking.
drop function public.sandbox_list_metadata();
create function public.sandbox_list_metadata()
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
 case when public.can_open_sandbox(s.org_id,s.owner_id) then s.task_outcome else null end,
 s.preservation_note, 'Sandbox ' || s.id::text,public.can_open_sandbox(s.org_id,s.owner_id),public.can_open_sandbox(s.org_id,s.owner_id)
 , coalesce(s.status='stopped' and s.status_reason='idle_paused',false)
 from public.sandboxes s
 where exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=auth.uid())
 and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
