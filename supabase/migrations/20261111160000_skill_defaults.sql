-- Personal defaults follow the user across organizations. All writes are service-owned.
create table public.personal_skill_defaults (
 user_id uuid primary key references auth.users(id) on delete cascade,
 skills jsonb not null check(jsonb_typeof(skills)='array' and jsonb_array_length(skills)<=20),
 updated_at timestamptz not null default now()
);
create table public.org_skill_defaults (
 org_id uuid primary key references public.orgs(id) on delete cascade,
 skills jsonb not null check(jsonb_typeof(skills)='array' and jsonb_array_length(skills)<=20),
 updated_at timestamptz not null default now()
);
create table public.golden_skill_defaults (
 golden_id uuid primary key references public.goldens(id) on delete cascade,
 skills jsonb not null check(jsonb_typeof(skills)='array' and jsonb_array_length(skills)<=20),
 updated_at timestamptz not null default now()
);
alter table public.personal_skill_defaults enable row level security;
alter table public.org_skill_defaults enable row level security;
alter table public.golden_skill_defaults enable row level security;
create policy personal_skill_defaults_read on public.personal_skill_defaults for select to authenticated using (
 user_id=auth.uid()
);
create policy org_skill_defaults_read on public.org_skill_defaults for select to authenticated using (
 exists(select 1 from public.members m where m.org_id=org_skill_defaults.org_id and m.user_id=auth.uid())
);
create policy golden_skill_defaults_read on public.golden_skill_defaults for select to authenticated using (
 exists(select 1 from public.goldens g where g.id=golden_id and g.removed_at is null
  and (g.visibility='org' or g.owner_id=auth.uid())
  and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=auth.uid()))
);
revoke all on public.personal_skill_defaults,public.org_skill_defaults,public.golden_skill_defaults from public,anon,authenticated;
grant select on public.personal_skill_defaults,public.org_skill_defaults,public.golden_skill_defaults to authenticated;
grant all on public.personal_skill_defaults,public.org_skill_defaults,public.golden_skill_defaults to service_role;
