-- Private durable interviews. Only the server can mutate or dispatch effects.
create table public.otto_interviews (
  objective_id uuid primary key references public.otto_objectives(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null
);
create table public.otto_interview_revisions (
  objective_id uuid not null references public.otto_interviews(objective_id) on delete cascade,
  revision integer not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  event text not null check (event in ('started','round','owner_answer','session_bound')),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (objective_id,revision)
);
create table public.otto_intentions (
  id uuid primary key default gen_random_uuid(),
  objective_id uuid not null references public.otto_objectives(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) > 0),
  kind text not null check (length(kind) > 0),
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending','dispatching','succeeded','unknown')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (objective_id,idempotency_key)
);
-- Journal data stays server-only: it may contain provider request/response details.
alter table public.otto_intentions enable row level security;
revoke all on public.otto_intentions from anon,authenticated;
grant all on public.otto_intentions to service_role;

alter table public.otto_interviews enable row level security;
alter table public.otto_interview_revisions enable row level security;
revoke all on public.otto_interviews, public.otto_interview_revisions from anon, authenticated;
grant select on public.otto_interviews, public.otto_interview_revisions to authenticated;
grant all on public.otto_interviews, public.otto_interview_revisions to service_role;
create policy otto_interview_read on public.otto_interviews for select to authenticated
using (owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_interviews.org_id and m.user_id=auth.uid()));
create policy otto_interview_revision_read on public.otto_interview_revisions for select to authenticated
using (owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=otto_interview_revisions.org_id and m.user_id=auth.uid()));
-- A different request key must not authorize a second engine session.
create unique index otto_one_engine_start on public.otto_intentions(objective_id) where kind='engine_start';
