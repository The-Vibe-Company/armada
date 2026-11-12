create table public.otto_tasks (
 org_id uuid not null references public.orgs(id), repository text not null,
 issue_number bigint not null, title text not null,
 state text not null check(state in ('open','unknown')),
 fact_id uuid not null references public.otto_facts(id),
 observed_at timestamptz not null,
 primary key(org_id,repository,issue_number)
);
create table public.otto_resources (
 org_id uuid not null references public.orgs(id), repository text not null,
 kind text not null check(kind in ('pr','sandbox')), external_id text not null,
 task_issue bigint, owner_state text not null check(owner_state in ('owned','orphan','unknown')),
 owner_id uuid, access_owner_id uuid, reason text not null,
 observed_at timestamptz, evidence jsonb not null,
 primary key(org_id,repository,kind,external_id)
);
-- Only the authorized server projection may write/read. No direct dashboard grants.
alter table public.otto_tasks enable row level security;
alter table public.otto_resources enable row level security;
revoke all on public.otto_tasks,public.otto_resources from public,anon,authenticated;
grant select,insert,update,delete on public.otto_tasks,public.otto_resources to service_role;
