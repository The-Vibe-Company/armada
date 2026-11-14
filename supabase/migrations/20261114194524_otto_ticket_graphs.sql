-- Planning records are separate from observed otto_tasks. Brief integration supplies revision later.
create table public.otto_ticket_graphs (
 objective_id uuid not null,
 org_id uuid not null,
 owner_id uuid not null,
 brief_revision integer not null check (brief_revision > 0),
 graph jsonb not null check (jsonb_typeof(graph) = 'object'),
 created_at timestamptz not null default now(),
 primary key (objective_id,brief_revision),
 foreign key(objective_id,org_id,owner_id) references public.otto_objectives(id,org_id,owner_id) on delete cascade
);
alter table public.otto_ticket_graphs enable row level security;
revoke all on public.otto_ticket_graphs from public,anon,authenticated;
grant select(objective_id,org_id,owner_id,brief_revision,graph,created_at) on public.otto_ticket_graphs to authenticated;
grant all on public.otto_ticket_graphs to service_role;
create policy owner_read on public.otto_ticket_graphs for select to authenticated using (
 owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_ticket_graphs.org_id and m.user_id=auth.uid())
);
