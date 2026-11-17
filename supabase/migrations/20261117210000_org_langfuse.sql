-- Server-only configuration: no user JWT can read either project key.
create table public.org_langfuse (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  enabled boolean not null default false,
  content_mode text not null check (content_mode in ('metadata', 'full')),
  config_enc bytea not null
);
alter table public.org_langfuse enable row level security;
revoke all on public.org_langfuse from public, anon, authenticated;
grant all on public.org_langfuse to service_role;
