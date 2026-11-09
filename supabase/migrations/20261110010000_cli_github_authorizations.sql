-- Pending account authorization is server-owned. No provider tokens or callback codes are retained here.
create table public.github_authorizations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique,
  status text not null check (status in ('pending', 'processing', 'connected', 'failed')),
  expires_at timestamptz not null
);
alter table public.github_authorizations enable row level security;
revoke all on public.github_authorizations from public, anon, authenticated;
grant select, insert, update, delete on public.github_authorizations to service_role;
create index github_authorizations_user_idx on public.github_authorizations(user_id);
