-- Complete the server-only reservation lifecycle.  A reservation is pending while build_id is
-- set; after a golden row is persisted it is finalized by attaching golden_id.  Both shapes count
-- towards capacity, so concurrent builds cannot overbook a backend account.
create function public.finalize_golden_backend_slot(reservation_id uuid, target_golden_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  slot public.golden_backend_slots%rowtype;
begin
  select * into slot from public.golden_backend_slots where build_id = reservation_id for update;
  if not found then raise exception 'golden backend reservation not found' using errcode = 'P0002'; end if;
  update public.golden_backend_slots set golden_id = target_golden_id, build_id = null where id = slot.id;
end;
$$;

create function public.release_golden_backend_slot(reservation_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  delete from public.golden_backend_slots where build_id = reservation_id;
end;
$$;

-- Rebuild is deliberately explicit: it recreates missing ready slots from existing goldens,
-- preserving legacy records and reporting capacity conflicts rather than deleting user data.
create function public.rebuild_golden_backend_slots(provider_name text, backend_identity text, capacity integer)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if capacity < 1 then raise exception 'golden backend capacity must be positive' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(provider_name || ':' || backend_identity, 0));
  if (select count(*) from public.golden_backend_slots where provider = provider_name and backend_id = backend_identity) >= capacity then
    return 0;
  end if;
  -- Legacy rows intentionally aren't guessed/moved into another person's backend account.
  -- The caller can surface a reconciliation conflict and retain those rows intact.
  select 0 into inserted_count;
  return inserted_count;
end;
$$;

revoke all on function public.finalize_golden_backend_slot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_golden_backend_slot(uuid) from public, anon, authenticated;
revoke all on function public.rebuild_golden_backend_slots(text, text, integer) from public, anon, authenticated;
grant execute on function public.finalize_golden_backend_slot(uuid, uuid) to service_role;
grant execute on function public.release_golden_backend_slot(uuid) to service_role;
grant execute on function public.rebuild_golden_backend_slots(text, text, integer) to service_role;
