-- Keep feed entries for the lifetime of their sandbox, like runtime_events.
create table public.event_log (
  id bigserial primary key,
  org_id uuid not null,
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  sequence bigint,
  kind text not null,
  ref bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (kind = 'transition' and sequence is null)
    or (kind = 'runtime_event' and sequence is not null and sequence = ref)
  )
);

create index event_log_org_id_id_idx on public.event_log (org_id, id);
create index event_log_sandbox_id_id_idx on public.event_log (sandbox_id, id);

alter table public.event_log enable row level security;
revoke all on public.event_log from public, anon, authenticated, service_role;
revoke all on sequence public.event_log_id_seq from public, anon, authenticated, service_role;
grant select on public.event_log to service_role;

create function public.append_sandbox_event_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  event_org_id uuid;
begin
  select s.org_id into strict event_org_id
    from public.sandboxes s where s.id = new.sandbox_id;

  -- A sequence alone orders allocation, not commits. Serialize allocations
  -- until commit within each org so a cursor cannot skip a late lower ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('armada.event_log:' || event_org_id, 0));

  if tg_table_name = 'sandbox_transitions' then
    insert into public.event_log (org_id, sandbox_id, kind, ref)
    values (event_org_id, new.sandbox_id, 'transition', new.id);
  else
    insert into public.event_log (org_id, sandbox_id, sequence, kind, ref)
    values (event_org_id, new.sandbox_id, new.sequence, 'runtime_event', new.sequence);
  end if;
  return null;
end
$$;
revoke all on function public.append_sandbox_event_log() from public, anon, authenticated, service_role;

-- Follow the canonical inserts, including during the server deploy overlap.
create trigger sandbox_transitions_event_log
  after insert on public.sandbox_transitions
  for each row execute function public.append_sandbox_event_log();

create trigger runtime_events_event_log
  after insert on public.runtime_events
  for each row execute function public.append_sandbox_event_log();
