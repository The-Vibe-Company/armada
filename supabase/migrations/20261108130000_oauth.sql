-- OAuth 2.1 clients and one-time authorization codes for the MCP authorization
-- server (#460). A code is stored as lowercase sha-256 hex, like a token.
-- Browser login state (the PKCE verifier and the Supabase session) stays in an
-- encrypted cookie, not in a table. service_role is the only role that can
-- read or write these tables: a user JWT has no grant and no policy.

create function public.oauth_redirects_ok(uris text[])
returns boolean
language plpgsql
immutable
as $$
declare
  uri text;
begin
  if uris is null or cardinality(uris) < 1 or cardinality(uris) > 8 then
    return false;
  end if;
  if exists (select 1 from unnest(uris) as item(uri) group by item.uri having count(*) > 1) then
    return false;
  end if;
  foreach uri in array uris loop
    if char_length(uri) > 2000 or uri ~ '[[:space:]#]' or position('@' in uri) > 0 then
      return false;
    end if;
    if uri ~ '^(javascript|data|file|blob):' then
      return false;
    elsif uri ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?&=+,%!-]*)?$' then
      null;
    elsif uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?&=+,%!-]*)?$' then
      null;
    elsif uri ~ '^[a-z][a-z0-9+.-]{1,32}://[A-Za-z0-9._~:/?&=+,%!-]+$' and uri !~ '^https?://' then
      null;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table public.oauth_clients (
  id text primary key,
  name text not null,
  redirect_uris text[] not null,
  created_at timestamptz not null default now(),
  constraint oauth_clients_id_chk check (id ~ '^[0-9a-f]{32}$'),
  constraint oauth_clients_name_chk check (char_length(btrim(name)) between 1 and 80),
  constraint oauth_clients_redirects_chk check (public.oauth_redirects_ok(redirect_uris))
);

comment on table public.oauth_clients is
  'Dynamically registered public OAuth clients. No client secret is issued.';

create table public.oauth_codes (
  hash text primary key,
  client_id text not null references public.oauth_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_codes_hash_chk check (hash ~ '^[0-9a-f]{64}$'),
  constraint oauth_codes_challenge_chk check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  constraint oauth_codes_redirect_chk check (public.oauth_redirects_ok(array[redirect_uri]))
);

comment on column public.oauth_codes.hash is
  'Lowercase sha-256 hex of the authorization code. The code itself is never stored.';

create index oauth_codes_user_id_idx on public.oauth_codes (user_id);
create index oauth_codes_org_id_idx on public.oauth_codes (org_id);

-- Using a code is the only change, and a used code stays used.
create function public.oauth_codes_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and (
    new.hash is distinct from old.hash
    or new.client_id is distinct from old.client_id
    or new.redirect_uri is distinct from old.redirect_uri
    or new.code_challenge is distinct from old.code_challenge
    or new.user_id is distinct from old.user_id
    or new.org_id is distinct from old.org_id
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'only used_at of an authorization code may change' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.used_at is not null and new.used_at is distinct from old.used_at then
    raise exception 'a used authorization code stays used' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger oauth_codes_guard
before update on public.oauth_codes
for each row execute function public.oauth_codes_guard();

alter table public.oauth_clients enable row level security;
alter table public.oauth_codes enable row level security;

grant select, insert, update, delete on public.oauth_clients to service_role;
grant select, insert, update, delete on public.oauth_codes to service_role;

-- MCP tokens are issued by the authorization server. A user can see and revoke
-- their own, and cannot mint one. Service tokens stay user-insertable.
revoke insert on public.mcp_tokens from authenticated;
