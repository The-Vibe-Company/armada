begin;

alter table public.service_tokens
  add column expires_at timestamptz,
  add column last_used_at timestamptz;

grant select (expires_at, last_used_at) on public.service_tokens to authenticated;

-- Authentication alone records usage. Preserve the existing owner insert privileges for key data.
revoke insert on public.service_tokens from authenticated;
grant insert (id, user_id, org_id, hash, label, revoked_at, created_at, expires_at)
  on public.service_tokens to authenticated;

-- The shared trigger still guards MCP tokens. Service keys also have immutable expiration.
create function public.service_tokens_usage_guard()
returns trigger
language plpgsql
as $$
begin
  if new.expires_at is distinct from old.expires_at then
    raise exception 'service token expiry cannot change' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger service_tokens_usage_guard
before update on public.service_tokens
for each row execute function public.service_tokens_usage_guard();

commit;
