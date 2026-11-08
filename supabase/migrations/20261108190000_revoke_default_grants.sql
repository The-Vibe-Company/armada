-- Restates the privileges of anon and authenticated from nothing.
-- Never edit a migration that has been applied.
--
-- Supabase grants ALL on every new table, sequence and function in public to anon and
-- authenticated through the default privileges of postgres. A column grant only adds to that
-- table-level grant, so the column lists of 20261108120100_rls.sql and later never narrowed
-- anything: a user JWT could read every *_enc column of the rows RLS showed it, and anon held
-- every table privilege, TRUNCATE included. Each table is revoked here and granted again with
-- the intended privileges only. RLS policies are unchanged.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- PUBLIC too: a per-schema default cannot revoke the global EXECUTE to PUBLIC, so the revoke of
-- 20261108120100_rls.sql missed every function created after it.
revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;

-- New objects get nothing for anon or authenticated until a migration grants it. Functions stay
-- executable by authenticated (20261108120100_rls.sql); each security definer checks auth.uid().
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges revoke execute on functions from public;

-- Ciphertext columns are writable by a user JWT where the dashboard writes them, and readable
-- only by service_role.
grant select (id, name, created_at), update (name, boat_api_key_enc), delete on public.orgs to authenticated;

grant select, insert (org_id, user_id, role, created_at), update (role), delete on public.members to authenticated;

grant select (id, scope, owner_id, kind, created_at),
  insert (id, scope, owner_id, kind, value_enc, created_at),
  update (value_enc),
  delete
  on public.credentials to authenticated;

grant select, insert,
  update (name, boat_snapshot_id, config, boat_sandbox_id),
  delete
  on public.goldens to authenticated;

grant select, insert,
  update (status, conversation_ids, stopped_at, deleted_at, status_reason)
  on public.sandboxes to authenticated;

grant select (sandbox_id, url, last_cursor, last_status, created_at),
  insert (sandbox_id, url, secret_enc, last_cursor, last_status, created_at),
  update (url, secret_enc, last_cursor, last_status),
  delete
  on public.notify_subscriptions to authenticated;

grant select, insert, update (revoked_at), delete on public.service_tokens to authenticated;

-- MCP tokens are minted by the authorization server only.
grant select, update (revoked_at), delete on public.mcp_tokens to authenticated;

-- oauth_clients and oauth_codes: service_role only.

-- The person reads their connection without the ciphertext and disconnects it. Connecting goes
-- through save_github_connection, so a user JWT writes no column of the table directly.
grant select (user_id, github_id, login, name, refresh_expires_at, revoked_at, created_at, updated_at),
  delete
  on public.github_connections to authenticated;

drop policy github_connections_insert on public.github_connections;
drop policy github_connections_update on public.github_connections;

-- Stores the caller's GitHub connection, replacing the previous one. The refresh token arrives
-- sealed by the dashboard and is never returned.
create function public.save_github_connection(
  github_user_id bigint,
  github_login text,
  github_name text,
  token_enc bytea,
  token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to connect GitHub' using errcode = '28000';
  end if;
  insert into public.github_connections (user_id, github_id, login, name, refresh_token_enc, refresh_expires_at)
  values (auth.uid(), github_user_id, github_login, github_name, token_enc, token_expires_at)
  on conflict (user_id) do update set
    github_id = excluded.github_id,
    login = excluded.login,
    name = excluded.name,
    refresh_token_enc = excluded.refresh_token_enc,
    refresh_expires_at = excluded.refresh_expires_at,
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke all on function public.save_github_connection(bigint, text, text, bytea, timestamptz) from public, anon;
grant execute on function public.save_github_connection(bigint, text, text, bytea, timestamptz)
  to authenticated, service_role;
