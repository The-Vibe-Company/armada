-- Where the Armada GitHub App is installed for a connected person.
-- Never edit a migration that has been applied.
--
-- Connect checks GET /user/installations after OAuth and stores the accounts it found
-- (login, user or organization, all repositories or a selected set). Nothing here is a
-- secret: a user JWT may read the column and still cannot read refresh_token_enc.
-- Null means the connection was saved before this was recorded.

alter table public.github_connections
  add column installations jsonb;

alter table public.github_connections
  add constraint github_connections_installations_chk check (
    installations is null
    or (jsonb_typeof(installations) = 'array' and octet_length(installations::text) <= 8000)
  );

comment on column public.github_connections.installations is
  'Installations of the Armada GitHub App visible at connect time. Not a secret. Null until recorded.';

grant select (installations) on public.github_connections to authenticated;

-- The previous signature had no installation list. Replace it; the new argument defaults
-- to null so a caller that only stores the token still works.
drop function public.save_github_connection(bigint, text, text, bytea, timestamptz);

create function public.save_github_connection(
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
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke all on function public.save_github_connection(bigint, text, text, bytea, timestamptz, jsonb) from public, anon;
grant execute on function public.save_github_connection(bigint, text, text, bytea, timestamptz, jsonb)
  to authenticated, service_role;
