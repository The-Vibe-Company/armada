-- Logical retirement only. References, capacity and physical artifacts remain owned by
-- their existing receipt/reference-count protocols; retirement never acknowledges GC.
alter table public.goldens add column removed_at timestamptz;
grant select (removed_at) on public.goldens to authenticated;

create table public.golden_operation_fences (
  id uuid primary key default gen_random_uuid(),
  golden_id uuid not null references public.goldens(id) on delete restrict,
  owner_id uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.golden_operation_fences enable row level security;
revoke all on public.golden_operation_fences from public, anon, authenticated;
grant all on public.golden_operation_fences to service_role;

create function public.guard_golden_admission() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare removed timestamptz;
begin
  -- Definer locking must not turn hidden tombstones into an existence oracle.
  if current_setting('role',true)='authenticated' and not exists(
    select 1 from public.goldens g join public.members m on m.org_id=g.org_id
    where g.id=new.golden_id and m.user_id=auth.uid()
      and (g.visibility='org' or g.owner_id=auth.uid())
  ) then raise exception 'Golden unavailable' using errcode='42501'; end if;
  select removed_at into removed from public.goldens where id=new.golden_id for update;
  if removed is not null then raise exception 'Golden is removed' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_golden_admission() from public,anon,authenticated;
create trigger golden_operation_admission before insert on public.golden_operation_fences
for each row execute function public.guard_golden_admission();
create trigger golden_sandbox_admission before insert on public.sandboxes
for each row execute function public.guard_golden_admission();
create trigger golden_slot_admission before insert or update on public.golden_backend_slots
for each row execute function public.guard_golden_admission();

create function public.remove_golden(target uuid) returns timestamptz
language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.goldens%rowtype; member_role public.member_role;
begin
  select * into g from public.goldens where id=target for update;
  if not found or (g.visibility='private' and g.owner_id<>auth.uid()) then
    raise exception 'No such golden' using errcode='P0002';
  end if;
  select role into member_role from public.members where org_id=g.org_id and user_id=auth.uid() for share;
  if not found then raise exception 'No such golden' using errcode='P0002'; end if;
  if g.visibility='org' and member_role<>'admin' then
    raise exception 'Only an org admin can remove this golden' using errcode='42501';
  end if;
  if g.removed_at is not null then return g.removed_at; end if;
  if exists(select 1 from public.golden_operation_fences where golden_id=target)
    or exists(select 1 from public.golden_backend_slots where golden_id=target and build_id is not null)
    or exists(select 1 from public.golden_build_jobs where org_id=g.org_id and name=g.name
      and provider=g.provider and state in ('queued','running','recovery_required')) then
    raise exception 'Golden has unresolved operations' using errcode='23514';
  end if;
  update public.goldens set removed_at=clock_timestamp() where id=target returning removed_at into g.removed_at;
  return g.removed_at;
end $$;
revoke all on function public.remove_golden(uuid) from public,anon;
grant execute on function public.remove_golden(uuid) to authenticated,service_role;

-- No direct tombstone mutation/undo, including through service-role source paths.
create function public.guard_removed_golden() returns trigger language plpgsql as $$
begin
  if old.removed_at is not null and new is distinct from old then
    raise exception 'Removed golden is immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_removed_golden() from public,anon,authenticated;
create trigger guard_removed_golden before update on public.goldens
for each row execute function public.guard_removed_golden();

-- Queue admission must serialize even before an update job has persisted golden_id.
create function public.guard_golden_job_admission() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare g record;
begin
  for g in select removed_at from public.goldens
    where org_id=new.org_id and name=new.name and provider=new.provider
      and visibility::text=new.visibility and (visibility='org' or owner_id=new.owner_id)
    order by id for update
  loop
    if g.removed_at is not null then raise exception 'Golden is removed' using errcode='23514'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.guard_golden_job_admission() from public,anon,authenticated;
create trigger golden_job_admission before insert on public.golden_build_jobs
for each row execute function public.guard_golden_job_admission();

-- RLS golden-store clients may hold only their own admissions. Server admissions
-- use the service role; these cannot be removed through a user JWT.
grant insert(golden_id), select(id), delete on public.golden_operation_fences to authenticated;
create policy golden_fence_read on public.golden_operation_fences for select to authenticated
  using(owner_id=auth.uid());
create policy golden_fence_delete on public.golden_operation_fences for delete to authenticated
  using(owner_id=auth.uid());
create policy golden_fence_insert on public.golden_operation_fences for insert to authenticated
  with check(owner_id=auth.uid() and exists(
    select 1 from public.goldens g join public.members m on m.org_id=g.org_id
    where g.id=golden_id and m.user_id=auth.uid() and g.removed_at is null
      and (g.visibility='org' or g.owner_id=auth.uid())));
