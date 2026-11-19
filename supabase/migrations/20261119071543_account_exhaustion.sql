create table public.account_exhaustion (
  account_id uuid primary key,
  credential_version integer not null,
  code text not null check (code in ('usage_limit_exceeded', 'rate_limited')),
  resets_at timestamptz,
  event_at bigint not null
);

alter table public.account_exhaustion enable row level security;
revoke all on public.account_exhaustion from public, anon, authenticated, service_role;
