-- Records which App installation, if any, Connect GitHub found for the person.
-- Never edit a migration that has been applied.
--
-- GET /user/installations is the only source of truth for whether the Armada GitHub App is
-- installed anywhere a person can reach, and for corroborating an installation_id an installation
-- return claims. The dashboard records the match it found so Settings can show installation
-- status and a "Manage installation" link without ever needing to decrypt the refresh token (a
-- user JWT cannot read that column) or call GitHub again just to render the page. Not a secret.

alter table public.github_connections add column installation_id bigint;

alter table public.github_connections
  add constraint github_connections_installation_id_chk check (installation_id is null or installation_id > 0);

grant select (installation_id) on public.github_connections to authenticated;

drop function public.save_github_connection(bigint, text, text, bytea, timestamptz);

-- Stores the caller's GitHub connection, replacing the previous one. The refresh token arrives
-- sealed by the dashboard and is never returned.
create function public.save_github_connection(
  github_user_id bigint,
  github_login text,
  github_name text,
  token_enc bytea,
  token_expires_at timestamptz,
  installation_id bigint
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
  insert into public.github_connections
    (user_id, github_id, login, name, refresh_token_enc, refresh_expires_at, installation_id)
  values (auth.uid(), github_user_id, github_login, github_name, token_enc, token_expires_at, installation_id)
  on conflict (user_id) do update set
    github_id = excluded.github_id,
    login = excluded.login,
    name = excluded.name,
    refresh_token_enc = excluded.refresh_token_enc,
    refresh_expires_at = excluded.refresh_expires_at,
    installation_id = excluded.installation_id,
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke all on function public.save_github_connection(bigint, text, text, bytea, timestamptz, bigint) from public, anon;
grant execute on function public.save_github_connection(bigint, text, text, bytea, timestamptz, bigint)
  to authenticated, service_role;
