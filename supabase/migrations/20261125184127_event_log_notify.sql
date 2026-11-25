-- Emit Postgres notifications on committed event_log entries so peer server
-- replicas wake SSE streams without waiting for the fallback recheck timer.
create or replace function public.append_sandbox_event_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  event_org_id uuid;
begin
  select s.org_id into event_org_id
    from public.sandboxes s where s.id = new.sandbox_id;

  -- A sandbox deleted in the same transaction has already expired.
  if not found then
    return null;
  end if;

  -- A sequence alone orders allocation, not commits. Serialize allocations
  -- near commit, after the producer's other work, so an org cursor cannot
  -- skip a late lower ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('armada.event_log:' || event_org_id, 0));

  if tg_table_name = 'sandbox_transitions' then
    insert into public.event_log (org_id, sandbox_id, kind, ref)
    values (event_org_id, new.sandbox_id, 'transition', new.id);
  else
    insert into public.event_log (org_id, sandbox_id, sequence, kind, ref)
    values (event_org_id, new.sandbox_id, new.sequence, 'runtime_event', new.sequence);
  end if;

  perform pg_catalog.pg_notify('armada_events', new.sandbox_id::text);
  return null;
end
$$;
revoke all on function public.append_sandbox_event_log() from public, anon, authenticated, service_role;
