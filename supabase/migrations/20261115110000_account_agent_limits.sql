-- Optional user-controlled concurrency cap, shared across all compute providers.
alter table public.credentials add column max_agents integer check (max_agents > 0);
update public.credentials set max_agents=2 where kind='morph';
grant select(max_agents) on public.credentials to authenticated;
create table public.account_agent_reservations (
  sandbox_id uuid primary key,
  account_id uuid not null references public.credentials(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.account_agent_reservations enable row level security;
revoke all on public.account_agent_reservations from anon, authenticated;
grant all on public.account_agent_reservations to service_role;
-- Once lifecycle state is published, that state replaces the temporary reservation.
create function public.release_account_agent_reservation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  delete from public.account_agent_reservations where sandbox_id=new.id;
  return new;
end;
$$;
create trigger release_account_agent_reservation
  after insert or update of status, stopped_at, deleted_at on public.sandboxes
  for each row execute function public.release_account_agent_reservation();
revoke all on function public.release_account_agent_reservation() from public, anon, authenticated;
