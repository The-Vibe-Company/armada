-- Application configuration is separate from managed provider/model credentials.
create table public.readable_variables (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  scope text not null check (scope in ('personal','org')),
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  value text,
  version integer not null default 1 check (version > 0),
  epoch integer not null default 1 check (epoch > 0),
  status text not null default 'active' check (status in ('active','revoked','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (value is null or octet_length(value) <= 8192),
  check ((status = 'active') = (value is not null))
);
create unique index readable_variables_name on public.readable_variables(org_id,scope,(case when scope='personal' then owner_id end),name) nulls not distinct where status <> 'deleted';

create table public.application_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  scope text not null check (scope in ('personal','org')),
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  value_enc bytea,
  version integer not null default 1 check (version > 0),
  epoch integer not null default 1 check (epoch > 0),
  status text not null default 'active' check (status in ('active','revoked','deleted')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'active') = (value_enc is not null))
);
create unique index application_secrets_name on public.application_secrets(org_id,scope,(case when scope='personal' then owner_id end),name) nulls not distinct where status <> 'deleted';

-- Opaque one-use ingress references. Only their SHA-256 hash is persisted.
create table public.application_secret_uploads (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  operation text not null check (operation in ('set','rotate')),
  target_id uuid,
  expected_version integer,
  scope text not null check (scope in ('personal','org')),
  name text not null,
  value_enc bytea not null,
  secret_expires_at timestamptz,
  expires_at timestamptz not null default now() + interval '5 minutes',
  check ((operation='set' and target_id is null and expected_version is null)
    or (operation='rotate' and target_id is not null and expected_version > 0))
);
create table public.application_vault_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  scope text not null check (scope in ('personal','org')),
  actor_id uuid not null references auth.users(id),
  resource_id uuid not null,
  kind text not null check (kind in ('variable','secret')),
  operation text not null check (operation in ('set','update','rotate','revoke','delete')),
  version integer not null,
  epoch integer not null,
  outcome text not null default 'succeeded' check (outcome='succeeded'),
  created_at timestamptz not null default now()
);

alter table public.readable_variables enable row level security;
alter table public.application_secrets enable row level security;
alter table public.application_secret_uploads enable row level security;
alter table public.application_vault_audit enable row level security;
create policy readable_variables_read on public.readable_variables for select to authenticated using (
  exists(select 1 from public.members m where m.org_id=readable_variables.org_id and m.user_id=auth.uid())
  and (scope='org' or owner_id=auth.uid())
);
create policy application_secrets_read on public.application_secrets for select to authenticated using (
  exists(select 1 from public.members m where m.org_id=application_secrets.org_id and m.user_id=auth.uid())
  and (scope='org' or owner_id=auth.uid())
);
create policy application_vault_audit_read on public.application_vault_audit for select to authenticated using (
  created_at > now()-interval '90 days' and
  exists(select 1 from public.members m where m.org_id=application_vault_audit.org_id and m.user_id=auth.uid()
    and ((application_vault_audit.scope='personal' and application_vault_audit.owner_id=auth.uid())
      or (application_vault_audit.scope='org' and m.role='admin')))
);
revoke all on public.readable_variables, public.application_secrets, public.application_secret_uploads, public.application_vault_audit from public, anon, authenticated;
grant all on public.readable_variables, public.application_secrets, public.application_secret_uploads, public.application_vault_audit to service_role;
grant select on public.readable_variables to authenticated;
grant select (id,org_id,owner_id,scope,name,version,epoch,status,expires_at,created_at,updated_at) on public.application_secrets to authenticated;
grant select on public.application_vault_audit to authenticated;
-- No JWT writes, including ciphertext writes: all mutation authorization/CAS/audit is server-owned.
