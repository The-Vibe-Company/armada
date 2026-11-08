-- Rebuild/adoption reservations retain the durable golden binding while marking an exclusive build.
alter table public.golden_backend_slots drop constraint golden_backend_slots_check;
alter table public.golden_backend_slots add check (golden_id is not null or build_id is not null);

create function public.reserve_existing_golden_backend_slot(provider_name text, backend_identity text, capacity integer, target_golden_id uuid)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare reservation uuid := gen_random_uuid(); slot public.golden_backend_slots%rowtype; g record; occupied integer;
begin
  if capacity < 1 then raise exception 'golden backend capacity must be positive' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(provider_name || ':' || backend_identity, 0));
  select org_id, owner_id into g from public.goldens where id=target_golden_id;
  if not found then raise exception 'golden not found' using errcode='P0002'; end if;
  select * into slot from public.golden_backend_slots where provider=provider_name and backend_id=backend_identity and golden_id=target_golden_id for update;
  if found then
    if slot.build_id is not null then raise exception 'golden backend build already in progress' using errcode='P0001'; end if;
    update public.golden_backend_slots set build_id=reservation, max_goldens=capacity where id=slot.id;
    return reservation;
  end if;
  select count(*) into occupied from public.golden_backend_slots where provider=provider_name and backend_id=backend_identity;
  if occupied >= capacity then raise exception 'golden backend capacity reached' using errcode='P0001'; end if;
  insert into public.golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id,build_id)
    values(provider_name,backend_identity,capacity,g.org_id,g.owner_id,target_golden_id,reservation);
  return reservation;
end;
$$;

create or replace function public.release_golden_backend_slot(reservation_id uuid) returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  delete from public.golden_backend_slots where build_id=reservation_id and golden_id is null;
  update public.golden_backend_slots set build_id=null where build_id=reservation_id and golden_id is not null;
end; $$;
create or replace function public.finalize_golden_backend_slot(reservation_id uuid, target_golden_id uuid) returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.golden_backend_slots set golden_id=target_golden_id, build_id=null where build_id=reservation_id;
  if not found then raise exception 'golden backend reservation not found' using errcode='P0002'; end if;
end; $$;
revoke all on function public.reserve_existing_golden_backend_slot(text,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.reserve_existing_golden_backend_slot(text,text,integer,uuid) to service_role;
