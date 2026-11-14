-- Graph materialization depends on this scoped server intention insert in one statement.
create table public.otto_ticket_publications (
 objective_id uuid not null,
 org_id uuid not null,
 owner_id uuid not null,
 brief_revision integer not null check (brief_revision > 0),
 tool text not null check (tool = 'publish_ticket_graph'),
 input jsonb not null check (jsonb_typeof(input) = 'object'),
 created_at timestamptz not null default now(),
 primary key(objective_id,brief_revision),
 foreign key(objective_id,org_id,owner_id)
  references public.otto_objectives(id,org_id,owner_id) on delete cascade
);
alter table public.otto_ticket_publications enable row level security;
revoke all on public.otto_ticket_publications from public,anon,authenticated;
grant all on public.otto_ticket_publications to service_role;
-- No JWT reads/writes: tool inputs are internal server records.
-- Existing graph FK already binds (objective_id,org_id,owner_id).
