begin;

-- Detached from the sandbox so normal deletion can purge its ordinary recovery.
create table public.native_drain_recovery (
  archive_id uuid primary key,
  sandbox_id uuid not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  archive_enc bytea not null check (octet_length(archive_enc) <= 3000000),
  created_at timestamptz not null default now()
);

create index native_drain_recovery_sandbox_idx on public.native_drain_recovery (sandbox_id);
create index native_drain_recovery_org_idx on public.native_drain_recovery (org_id);
create index native_drain_recovery_owner_idx on public.native_drain_recovery (owner_id);

alter table public.native_drain_recovery enable row level security;
revoke all on public.native_drain_recovery from public, anon, authenticated, service_role;
grant select, delete on public.native_drain_recovery to service_role;

create function public.copy_native_drain_recovery(p_sandbox_id uuid, p_generation bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_sandbox public.sandboxes%rowtype;
  v_archive_id uuid;
begin
  -- Serialize with preservation publication, taint and lifecycle admission.
  select * into v_sandbox from public.sandboxes s where s.id = p_sandbox_id for update;
  if not found
    or v_sandbox.lifecycle_generation is distinct from p_generation
    or v_sandbox.provider not in ('boat', 'modal')
    or v_sandbox.provider_sandbox_id is null
    or v_sandbox.boat_runtime
    or v_sandbox.runtime_transport is not distinct from 'dialout'
    or v_sandbox.application_secret_tainted
    or v_sandbox.deleted_at is not null
    or v_sandbox.status not in ('stopped', 'failed')
    or v_sandbox.stopped_at is null
    or v_sandbox.stop_requested_at is not null
    or v_sandbox.activity_until > clock_timestamp()
    or v_sandbox.reconcile_lease_until > clock_timestamp()
  then
    return 'ineligible';
  end if;

  -- Read the receipt after taking the row lock. Never substitute an older archive.
  select r.archive_id into v_archive_id
  from public.sandbox_native_preservation_receipts r
  where r.sandbox_id = p_sandbox_id
    and r.generation = p_generation
    and r.stop_generation = v_sandbox.stop_generation
    and r.stop_generation = v_sandbox.preservation_stop_generation
    and r.capture_generation = r.generation
    and r.capture_stop_generation = r.stop_generation;

  if not found then return 'unverified'; end if;
  if v_archive_id is null then return 'clean'; end if;

  -- Check the live source on every call, including a replay of a successful copy.
  perform 1 from public.sandbox_work_recovery a
  where a.id = v_archive_id and a.sandbox_id = p_sandbox_id for share;
  if not found then return 'unverified'; end if;

  insert into public.native_drain_recovery (archive_id, sandbox_id, org_id, owner_id, archive_enc)
  select a.id, a.sandbox_id, v_sandbox.org_id, v_sandbox.owner_id, a.archive_enc
  from public.sandbox_work_recovery a where a.id = v_archive_id
  on conflict (archive_id) do nothing;
  return 'archived';
end;
$$;

revoke all on function public.copy_native_drain_recovery(uuid, bigint) from public, anon, authenticated;
grant execute on function public.copy_native_drain_recovery(uuid, bigint) to service_role;

-- Supersede the existing trigger body atomically with creation of the private store.
create or replace function public.enforce_application_secret_taint() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.application_secret_tainted and not new.application_secret_tainted then
    raise exception 'Application-secret taint is irreversible';
  end if;
  if new.application_secret_tainted then
    delete from public.sandbox_work_recovery where sandbox_id=new.id;
    delete from public.native_drain_recovery where sandbox_id=new.id;
    new.preservation_note := 'Unpushed work was not preserved: application-secret exposure forbids archives and disk reuse; resume and recovery are unavailable.';
  end if;
  return new;
end;
$$;

commit;
