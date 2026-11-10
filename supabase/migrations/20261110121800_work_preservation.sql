-- Public receipt is metadata only. Recovery payload is service-role only.
alter table public.sandboxes add column preservation_note text;
grant select (preservation_note) on public.sandboxes to authenticated;
create table public.sandbox_work_recovery (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  archive_enc bytea not null check (octet_length(archive_enc) <= 3000000),
  created_at timestamptz not null default now()
);
alter table public.sandbox_work_recovery enable row level security;
revoke all on public.sandbox_work_recovery from anon, authenticated;
grant all on public.sandbox_work_recovery to service_role;

-- Extend the dashboard safe metadata projection without exposing recovery ciphertext.
drop function public.sandbox_list_metadata();
create function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "preservationNote" text, "displayLabel" text, "canOpen" boolean, "canManage" boolean
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 s.preservation_note, 'Sandbox ' || s.id::text,public.can_open_sandbox(s.org_id,s.owner_id),public.can_open_sandbox(s.org_id,s.owner_id)
 from public.sandboxes s
 where exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=auth.uid())
 and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;
