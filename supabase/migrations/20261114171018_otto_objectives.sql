-- Durable private objective threads, independent of replaceable observation projections.
create table public.otto_objectives (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
 request text not null check (length(btrim(request)) between 1 and 20000),
 revision integer not null default 1 check (revision > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,org_id,owner_id)
);
create table public.otto_objective_messages (
 id uuid primary key default gen_random_uuid(),
 objective_id uuid not null,
 org_id uuid not null,
 owner_id uuid not null,
 body text not null check (length(btrim(body)) between 1 and 20000),
 revision integer not null default 1 check (revision > 0),
 created_at timestamptz not null default now(),
 foreign key(objective_id,org_id,owner_id) references public.otto_objectives(id,org_id,owner_id) on delete cascade
);
create index on public.otto_objectives(org_id,owner_id,created_at,id);
create index on public.otto_objective_messages(objective_id,created_at,id);
alter table public.otto_objectives enable row level security;
alter table public.otto_objective_messages enable row level security;
revoke all on public.otto_objectives,public.otto_objective_messages from public,anon,authenticated;
grant select(id,org_id,owner_id,repository,request,revision,created_at,updated_at) on public.otto_objectives to authenticated;
grant select(id,objective_id,org_id,owner_id,body,revision,created_at) on public.otto_objective_messages to authenticated;
grant all on public.otto_objectives,public.otto_objective_messages to service_role;
create policy owner_read on public.otto_objectives for select to authenticated using (
 owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_objectives.org_id and m.user_id=auth.uid())
);
create policy owner_read on public.otto_objective_messages for select to authenticated using (
 owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_objective_messages.org_id and m.user_id=auth.uid())
);
