-- Serialize GitHub refresh-token rotation across server replicas and retain only sealed access tokens.
-- The function is service-role only; user JWTs cannot read or invoke it.
alter table public.github_connections
  add column access_token_enc bytea,
  add column access_expires_at timestamptz;

comment on column public.github_connections.access_token_enc is 'Ciphertext. Never a raw token.';

create or replace function public.github_connection_for_refresh(p_user_id uuid)
returns table (
  user_id uuid,
  github_id bigint,
  login text,
  name text,
  refresh_token_enc bytea,
  refresh_expires_at timestamptz,
  access_token_enc bytea,
  access_expires_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  return query
    select c.user_id, c.github_id, c.login, c.name, c.refresh_token_enc, c.refresh_expires_at,
      c.access_token_enc, c.access_expires_at, c.revoked_at
    from public.github_connections c
    where c.user_id = p_user_id;
end;
$$;

revoke all on function public.github_connection_for_refresh(uuid) from public, anon, authenticated;
grant execute on function public.github_connection_for_refresh(uuid) to service_role;
