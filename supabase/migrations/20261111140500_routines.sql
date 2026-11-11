-- Configuration-only first slice: no enabled state until the durable scheduler ships.
create table public.routines (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 scope text not null check(scope in ('personal','org')),
 name text not null check(length(btrim(name)) between 1 and 200),
 template_id uuid not null,
 template_revision integer not null check(template_revision>0),
 prompt text not null check(length(btrim(prompt)) between 1 and 32000),
 interval_hours integer not null check(interval_hours between 1 and 720),
 max_runs_per_day integer not null check(max_runs_per_day between 1 and 24),
 ttl_seconds integer not null check(ttl_seconds between 300 and 86400),
 status text not null default 'paused' check(status in ('paused','deleted')),
 version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(template_id,template_revision) references public.launch_template_revisions(template_id,revision)
);
create index routines_org on public.routines(org_id) where status='paused';
alter table public.routines enable row level security;
create policy routines_read on public.routines for select to authenticated using (
 exists(select 1 from public.members m where m.org_id=routines.org_id and m.user_id=auth.uid())
 and (scope='org' or owner_id=auth.uid())
);
revoke all on public.routines from public,anon,authenticated;
grant select on public.routines to authenticated;
grant all on public.routines to service_role;
