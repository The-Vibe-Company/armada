begin;

create function public.guard_authenticated_native_drain_stop()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  -- Strict stop admission locks the sandbox before publishing the marker.
  -- Read it after the UPDATE locks the row, using a fresh statement snapshot.
  if exists (
    select 1 from public.native_drain_stop_requests r
    where r.sandbox_id = old.id and r.stop_generation = old.stop_generation
  ) then
    raise exception using errcode = '55000', message = 'Sandbox has an active native drain stop.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_authenticated_native_drain_stop() from public, anon, authenticated, service_role;

create trigger guard_authenticated_native_drain_stop
  before update on public.sandboxes
  for each row when (current_user = 'authenticated')
  execute function public.guard_authenticated_native_drain_stop();

commit;
