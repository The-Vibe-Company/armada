-- GitHub user-to-server connection (one per person).
-- Never edit a migration that has been applied.
--
-- A GitHub App user authorization gives Armada an expiring user access token (8 hours) and a
-- refresh token (6 months, rotated on every use). Only the refresh token is stored, as ciphertext
-- under ARMADA_ENCRYPTION_KEY; launch exchanges it for a fresh access token and puts that in the
-- sandbox, so git and `gh` there act as this person.

create table public.github_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Display and identity fields, refreshed from GitHub at launch. Not secrets.
  github_id bigint not null,
  login text not null,
  name text,
  -- Ciphertext. Never a raw token.
  refresh_token_enc bytea not null,
  refresh_expires_at timestamptz,
  -- Set when GitHub refused the refresh token (the grant was revoked or expired): reconnect.
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint github_connections_github_id_chk check (github_id > 0),
  constraint github_connections_login_chk check (char_length(btrim(login)) between 1 and 100),
  constraint github_connections_refresh_token_enc_chk check (octet_length(refresh_token_enc) > 0)
);

comment on column public.github_connections.refresh_token_enc is 'Ciphertext. Never a raw token.';

alter table public.github_connections enable row level security;

-- The ciphertext is writable by the person (the dashboard callback runs as them) and readable only
-- by service_role, which launch uses to refresh and to store the rotated token.
grant select (user_id, github_id, login, name, refresh_expires_at, revoked_at, created_at, updated_at),
  insert (user_id, github_id, login, name, refresh_token_enc, refresh_expires_at, revoked_at, created_at, updated_at),
  update (github_id, login, name, refresh_token_enc, refresh_expires_at, revoked_at, updated_at),
  delete
  on public.github_connections to authenticated;
grant select, insert, update, delete on public.github_connections to service_role;

create policy github_connections_select on public.github_connections
for select to authenticated
using (user_id = auth.uid());

create policy github_connections_insert on public.github_connections
for insert to authenticated
with check (user_id = auth.uid());

create policy github_connections_update on public.github_connections
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy github_connections_delete on public.github_connections
for delete to authenticated
using (user_id = auth.uid());
