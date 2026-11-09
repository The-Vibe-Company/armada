-- Drain all old readers/writers before activation; see docs/contracts/sandbox-access-v1.md.
-- Raw rows and dependent notify policies stay interior-only. Metadata is a separate projection.
create function public.can_open_sandbox(target_org uuid, target_owner uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.members m where m.org_id=target_org and m.user_id=auth.uid()
    and (target_owner=auth.uid() or m.role='admin'))
$$;
revoke all on function public.can_open_sandbox(uuid,uuid) from public,anon;
grant execute on function public.can_open_sandbox(uuid,uuid) to authenticated,service_role;

drop policy sandboxes_select on public.sandboxes;
drop policy sandboxes_update on public.sandboxes;
create policy sandboxes_select on public.sandboxes for select to authenticated
using (public.can_open_sandbox(org_id,owner_id));
create policy sandboxes_update on public.sandboxes for update to authenticated
using (public.can_open_sandbox(org_id,owner_id))
with check (public.can_open_sandbox(org_id,owner_id));

create function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "displayLabel" text, "canOpen" boolean, "canManage" boolean
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 'Sandbox ' || s.id::text,public.can_open_sandbox(s.org_id,s.owner_id),public.can_open_sandbox(s.org_id,s.owner_id)
 from public.sandboxes s
 where exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=auth.uid())
 and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
