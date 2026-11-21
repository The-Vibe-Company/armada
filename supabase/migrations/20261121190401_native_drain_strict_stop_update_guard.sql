begin;

create function public.guard_native_drain_strict_stop_update()
returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  -- The UPDATE already holds the sandbox row lock. Read a fresh snapshot
  -- because strict stop admission may have published the marker while it waited.
  if exists (
    select 1 from public.native_drain_stop_requests r
    where r.sandbox_id = old.id and r.stop_generation = old.stop_generation
  ) then
    raise exception 'Sandbox update is unavailable.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_native_drain_strict_stop_update()
  from public, anon, authenticated;

create trigger guard_native_drain_strict_stop_update
before update on public.sandboxes
for each row when (current_user = 'authenticated')
execute function public.guard_native_drain_strict_stop_update();

commit;
