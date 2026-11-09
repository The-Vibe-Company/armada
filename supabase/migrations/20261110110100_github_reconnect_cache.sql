-- Deploy before the server update; older servers must be drained for the full profile fence.
-- Reconnect replaces the grant and invalidates its derived cache atomically.
create or replace function public.save_github_connection(
  github_user_id bigint,
  github_login text,
  github_name text,
  token_enc bytea,
  token_expires_at timestamptz,
  installation_list jsonb default null
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
  -- Same transaction lock as resolveGitHubAccess: a reconnect cannot publish B
  -- until every refresh/cache/profile write for A has finished.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  insert into public.github_connections (
    user_id, github_id, login, name, refresh_token_enc, refresh_expires_at, installations
  )
  values (
    auth.uid(), github_user_id, github_login, github_name, token_enc, token_expires_at, installation_list
  )
  on conflict (user_id) do update set
    github_id = excluded.github_id,
    login = excluded.login,
    name = excluded.name,
    refresh_token_enc = excluded.refresh_token_enc,
    refresh_expires_at = excluded.refresh_expires_at,
    installations = excluded.installations,
    access_token_enc = null,
    access_expires_at = null,
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke all on function public.save_github_connection(bigint, text, text, bytea, timestamptz, jsonb) from public, anon;
grant execute on function public.save_github_connection(bigint, text, text, bytea, timestamptz, jsonb)
  to authenticated, service_role;
