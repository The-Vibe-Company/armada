-- Refresh-bearing native sessions have one durable sandbox owner.
-- No TTL: an expired scheduling lease cannot fence a CLI that still has its
-- refresh token. Reassignment needs private native-state publication/revocation.
create table public.model_auth_ownership (
  account_id uuid primary key references public.credentials(id) on delete cascade,
  account_version bigint not null check (account_version > 0),
  sandbox_id uuid not null,
  assigned_at timestamptz not null default now()
);
alter table public.model_auth_ownership enable row level security;
revoke all on public.model_auth_ownership from anon, authenticated;
grant all on public.model_auth_ownership to service_role;

-- Native refresh state is separate from explicit credential replacement/version.
create table public.model_auth_state (
  account_id uuid not null references public.credentials(id) on delete cascade,
  account_version integer not null check(account_version > 0),
  auth_revision integer not null default 0 check(auth_revision >= 0),
  state_enc bytea not null,
  source_generation text not null,
  updated_at timestamptz not null default now(),
  primary key(account_id, account_version)
);
alter table public.model_auth_state enable row level security;
revoke all on public.model_auth_state from anon, authenticated;
grant all on public.model_auth_state to service_role;
create index model_auth_ownership_sandbox on public.model_auth_ownership(sandbox_id);
