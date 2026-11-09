-- Durable authority and nonsecret recovery context. Never accessible through user JWTs.
create table public.modal_server_apps (
  org_id uuid not null references public.orgs(id) on delete cascade,
  authority text not null,
  authority_scope text not null check (authority_scope in ('user','org')),
  authority_owner_id uuid not null,
  app_name text not null,
  app_id text not null,
  environment text not null,
  primary key(org_id,authority,environment),
  unique(org_id,app_id,environment)
);
create table public.modal_server_scopes (
  scope text primary key,
  context jsonb not null
);
create table public.modal_server_harnesses (
  scope text not null references public.modal_server_scopes(scope) on delete cascade,
  machine_id text not null,
  github_enabled boolean not null default false,
  harness text not null check(harness in ('claude','codex')),
  primary key(scope,machine_id)
);
alter table public.modal_server_apps enable row level security;
alter table public.modal_server_scopes enable row level security;
alter table public.modal_server_harnesses enable row level security;
revoke all on public.modal_server_apps, public.modal_server_scopes, public.modal_server_harnesses from public, anon, authenticated;
grant all on public.modal_server_apps, public.modal_server_scopes, public.modal_server_harnesses to service_role;
