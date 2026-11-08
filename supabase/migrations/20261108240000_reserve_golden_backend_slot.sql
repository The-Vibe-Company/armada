create function public.reserve_golden_backend_slot(
  provider_name text,
  backend_identity text,
  capacity integer,
  target_org_id uuid,
  target_owner_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reservation uuid := gen_random_uuid();
  occupied integer;
begin
  if capacity < 1 then raise exception 'golden backend capacity must be positive' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(provider_name || ':' || backend_identity, 0));
  select count(*) into occupied from public.golden_backend_slots
    where provider = provider_name and backend_id = backend_identity;
  if occupied >= capacity then
    raise exception 'golden backend capacity reached' using errcode = 'P0001';
  end if;
  insert into public.golden_backend_slots (provider, backend_id, max_goldens, org_id, owner_id, build_id)
    values (provider_name, backend_identity, capacity, target_org_id, target_owner_id, reservation);
  return reservation;
end;
$$;
revoke all on function public.reserve_golden_backend_slot(text, text, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_golden_backend_slot(text, text, integer, uuid, uuid) to service_role;
