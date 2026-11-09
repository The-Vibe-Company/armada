-- Server-owned control plane. No management credentials or bootstrap payloads are stored here.
create table public.modal_machines (
  scope text not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  visibility public.visibility not null,
  id text not null,
  request_key text not null,
  record jsonb not null,
  lease_id uuid,
  lease_until timestamptz,
  primary key(scope,id), unique(scope,request_key)
);
create table public.modal_images (
  scope text not null, name text not null, source_id text not null, record jsonb not null,
  primary key(scope,name),
  foreign key(scope,source_id) references public.modal_machines(scope,id)
);
create table public.modal_events (
  cursor bigint generated always as identity primary key,
  scope text not null, sandbox_id text not null, generation text not null,
  producer_sequence bigint not null check(producer_sequence > 0), event jsonb not null,
  unique(scope,sandbox_id,generation,producer_sequence),
  foreign key(scope,sandbox_id) references public.modal_machines(scope,id)
);
create index modal_events_replay on public.modal_events(scope,sandbox_id,cursor);
alter table public.modal_machines enable row level security;
alter table public.modal_images enable row level security;
alter table public.modal_events enable row level security;
revoke all on public.modal_machines, public.modal_images, public.modal_events from anon, authenticated;
revoke all on sequence public.modal_events_cursor_seq from anon, authenticated;
grant all on public.modal_machines, public.modal_images, public.modal_events to service_role;
grant usage, select on sequence public.modal_events_cursor_seq to service_role;
-- Deliberately no user policies: tenant/caller checks are mandatory in the server SQL port.
