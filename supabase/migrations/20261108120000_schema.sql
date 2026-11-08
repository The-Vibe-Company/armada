-- Armada's schema. Requires a Supabase database: auth.users, auth.uid(), and the
-- authenticated and service_role roles already exist. Never edit this file once
-- it has been applied; add a new migration.
--
-- Secrets are ciphertext (bytea, *_enc) or a sha-256 hex hash. Nothing here is
-- a raw key. Golden config is a JSON object and rejects secret-like keys.
-- boat_snapshot_id stores the provider's saved-snapshot name (boat.dev has no
-- separate snapshot id). sandbox status follows core's SandboxState, plus
-- deleted for Armada's own cleanup (the provider has no deleted state).

create type public.member_role as enum ('admin', 'member');
create type public.credential_scope as enum ('user', 'org');
create type public.credential_kind as enum ('anthropic', 'openai', 'claude_oauth', 'boat');
create type public.visibility as enum ('org', 'private');
create type public.harness as enum ('claude', 'codex');
create type public.sandbox_status as enum (
  'starting',
  'ready',
  'running',
  'stopping',
  'stopped',
  'failed',
  'deleted'
);
create type public.notify_status as enum ('finished', 'failed');

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Null until an admin sets the org's boat.dev key. Ciphertext only.
  boat_api_key_enc bytea,
  created_at timestamptz not null default now(),
  constraint orgs_name_chk check (char_length(btrim(name)) between 1 and 120),
  constraint orgs_boat_api_key_enc_chk check (boat_api_key_enc is null or octet_length(boat_api_key_enc) > 0)
);

comment on column public.orgs.boat_api_key_enc is 'Ciphertext of the org boat.dev key. Never a raw key.';

create table public.members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index members_user_id_idx on public.members (user_id);

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  scope public.credential_scope not null,
  -- scope user: an auth.users id. scope org: an orgs id. Checked by credentials_guard.
  owner_id uuid not null,
  kind public.credential_kind not null,
  value_enc bytea not null,
  created_at timestamptz not null default now(),
  constraint credentials_value_enc_chk check (octet_length(value_enc) > 0),
  constraint credentials_owner_kind_key unique (scope, owner_id, kind)
);

comment on column public.credentials.value_enc is 'Ciphertext. Never a raw key.';
comment on column public.credentials.owner_id is 'auth.users id when scope is user; orgs id when scope is org.';

create index credentials_owner_idx on public.credentials (scope, owner_id);

create table public.goldens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  visibility public.visibility not null,
  owner_id uuid not null references auth.users (id) on delete restrict,
  -- The provider's saved-snapshot name. Null until the golden is snapshotted.
  boat_snapshot_id text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint goldens_name_chk check (char_length(btrim(name)) between 1 and 120),
  constraint goldens_boat_snapshot_id_chk check (boat_snapshot_id is null or char_length(boat_snapshot_id) > 0),
  constraint goldens_config_object_chk check (jsonb_typeof(config) = 'object')
);

create index goldens_org_id_idx on public.goldens (org_id);
create index goldens_owner_id_idx on public.goldens (owner_id);

-- Org-visible names are unique in the org. Private names are unique per owner.
create unique index goldens_org_name_key on public.goldens (org_id, name)
  where visibility = 'org';

create unique index goldens_private_name_key on public.goldens (org_id, owner_id, name)
  where visibility = 'private';

create unique index goldens_boat_snapshot_id_key on public.goldens (boat_snapshot_id)
  where boat_snapshot_id is not null;

create table public.sandboxes (
  id uuid primary key default gen_random_uuid(),
  boat_id text not null,
  golden_id uuid not null references public.goldens (id) on delete restrict,
  org_id uuid not null references public.orgs (id) on delete restrict,
  owner_id uuid not null references auth.users (id) on delete restrict,
  harness public.harness not null,
  status public.sandbox_status not null,
  conversation_ids text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  stopped_at timestamptz,
  deleted_at timestamptz,
  constraint sandboxes_boat_id_chk check (char_length(boat_id) > 0),
  constraint sandboxes_boat_id_key unique (boat_id),
  constraint sandboxes_conversation_ids_chk check (array_position(conversation_ids, null) is null)
);

create index sandboxes_golden_id_idx on public.sandboxes (golden_id);
create index sandboxes_org_id_idx on public.sandboxes (org_id);
create index sandboxes_owner_id_idx on public.sandboxes (owner_id);

-- One webhook per sandbox: launch takes a single notify_url.
create table public.notify_subscriptions (
  sandbox_id uuid primary key references public.sandboxes (id) on delete cascade,
  url text not null,
  -- Ciphertext of the webhook signing secret. Never the raw secret.
  secret_enc bytea not null,
  last_cursor text,
  last_status public.notify_status,
  created_at timestamptz not null default now(),
  constraint notify_subscriptions_url_chk check (
    url ~ '^https://'
    or url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'
  ),
  constraint notify_subscriptions_secret_enc_chk check (octet_length(secret_enc) > 0)
);

comment on column public.notify_subscriptions.secret_enc is 'Ciphertext of the webhook signing secret. Never the raw secret.';

-- hash is the sha-256 hex of the token. The token itself is never stored.
create table public.service_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  hash text not null,
  label text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint service_tokens_hash_chk check (hash ~ '^[0-9a-f]{64}$'),
  constraint service_tokens_hash_key unique (hash),
  constraint service_tokens_label_chk check (char_length(btrim(label)) between 1 and 80)
);

create index service_tokens_user_id_idx on public.service_tokens (user_id);
create index service_tokens_org_id_idx on public.service_tokens (org_id);

create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  hash text not null,
  label text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_tokens_hash_chk check (hash ~ '^[0-9a-f]{64}$'),
  constraint mcp_tokens_hash_key unique (hash),
  constraint mcp_tokens_label_chk check (char_length(btrim(label)) between 1 and 80)
);

create index mcp_tokens_user_id_idx on public.mcp_tokens (user_id);
create index mcp_tokens_org_id_idx on public.mcp_tokens (org_id);

-- A key is secret when it is one of these words, or ends or starts a compound with one.
create function public.is_secret_key(key text)
returns boolean
language sql
immutable
as $$
  select regexp_replace(lower(key), '-', '_', 'g')
    ~ '(^|_)(secrets?|passwords?|passwds?|tokens?|api_keys?|apikeys?|authorizations?|credentials?|private_keys?|access_keys?|boat_api_keys?)($|_)';
$$;

create function public.first_secret_key(value jsonb)
returns text
language plpgsql
immutable
as $$
declare
  entry record;
  nested text;
begin
  if jsonb_typeof(value) = 'object' then
    for entry in select key, item from jsonb_each(value) as pair(key, item) loop
      if public.is_secret_key(entry.key) then
        return entry.key;
      end if;
      nested := public.first_secret_key(entry.item);
      if nested is not null then
        return entry.key || '.' || nested;
      end if;
    end loop;
  elsif jsonb_typeof(value) = 'array' then
    for entry in select item from jsonb_array_elements(value) as element(item) loop
      nested := public.first_secret_key(entry.item);
      if nested is not null then
        return nested;
      end if;
    end loop;
  end if;
  return null;
end;
$$;

create function public.goldens_guard()
returns trigger
language plpgsql
as $$
declare
  secret_key text;
begin
  if jsonb_typeof(new.config) <> 'object' then
    raise exception 'golden config must be a JSON object' using errcode = '23514';
  end if;
  secret_key := public.first_secret_key(new.config);
  if secret_key is not null then
    raise exception 'golden config must not contain secrets (key "%")', secret_key using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.org_id is distinct from old.org_id
    or new.visibility is distinct from old.visibility
    or new.owner_id is distinct from old.owner_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'golden id, org, visibility, owner and created_at are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger goldens_guard
before insert or update on public.goldens
for each row execute function public.goldens_guard();

create function public.sandboxes_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  golden public.goldens;
begin
  select * into golden from public.goldens where id = new.golden_id;
  if not found then
    raise exception 'sandbox golden does not exist' using errcode = '23503';
  end if;
  if new.org_id is distinct from golden.org_id then
    raise exception 'sandbox org must match its golden' using errcode = '23514';
  end if;
  if golden.visibility = 'private' and new.owner_id is distinct from golden.owner_id then
    raise exception 'a private sandbox belongs to the golden owner' using errcode = '23514';
  end if;
  if new.status in ('starting', 'ready', 'running') and (new.stopped_at is not null or new.deleted_at is not null) then
    raise exception 'an active sandbox has no stopped_at or deleted_at' using errcode = '23514';
  end if;
  if new.status = 'stopping' and new.deleted_at is not null then
    raise exception 'a stopping sandbox is not deleted' using errcode = '23514';
  end if;
  if new.status = 'stopped' and new.stopped_at is null then
    raise exception 'a stopped sandbox records stopped_at' using errcode = '23514';
  end if;
  if new.status = 'deleted' and new.deleted_at is null then
    raise exception 'a deleted sandbox records deleted_at' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.boat_id is distinct from old.boat_id
    or new.golden_id is distinct from old.golden_id
    or new.org_id is distinct from old.org_id
    or new.owner_id is distinct from old.owner_id
    or new.harness is distinct from old.harness
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'sandbox identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sandboxes_guard
before insert or update on public.sandboxes
for each row execute function public.sandboxes_guard();

create function public.credentials_guard()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.scope = 'user' and not exists (select 1 from auth.users where id = new.owner_id) then
    raise exception 'user credential owner does not exist' using errcode = '23503';
  end if;
  if new.scope = 'org' and not exists (select 1 from public.orgs where id = new.owner_id) then
    raise exception 'org credential owner does not exist' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.scope is distinct from old.scope
    or new.owner_id is distinct from old.owner_id
    or new.kind is distinct from old.kind
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'only the ciphertext of a credential may change' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger credentials_guard
before insert or update on public.credentials
for each row execute function public.credentials_guard();

-- User-scoped credentials have no foreign key (owner_id is polymorphic), so the
-- user delete removes them. Org credentials stay with the org.
create function public.credentials_on_user_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.credentials where scope = 'user' and owner_id = old.id;
  return old;
end;
$$;

create trigger credentials_on_user_delete
before delete on auth.users
for each row execute function public.credentials_on_user_delete();

create function public.credentials_on_org_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.credentials where scope = 'org' and owner_id = old.id;
  return old;
end;
$$;

create trigger credentials_on_org_delete
before delete on public.orgs
for each row execute function public.credentials_on_org_delete();

-- Refuses to demote or remove the last admin. Membership identity never changes.
create function public.members_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and (new.org_id is distinct from old.org_id or new.user_id is distinct from old.user_id) then
    raise exception 'membership identity is immutable' using errcode = '23514';
  end if;
  if (tg_op = 'DELETE' and old.role = 'admin')
    or (tg_op = 'UPDATE' and old.role = 'admin' and new.role is distinct from 'admin')
  then
    if not exists (
      select 1 from public.members
      where org_id = old.org_id and role = 'admin' and user_id is distinct from old.user_id
    ) then
      raise exception 'an org keeps at least one admin' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger members_guard
before update or delete on public.members
for each row execute function public.members_guard();

-- Revocation is the only change. A revoked token stays revoked.
create function public.tokens_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.org_id is distinct from old.org_id
    or new.hash is distinct from old.hash
    or new.label is distinct from old.label
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'only revoked_at of a token may change' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked token stays revoked' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger service_tokens_guard
before update on public.service_tokens
for each row execute function public.tokens_guard();

create trigger mcp_tokens_guard
before update on public.mcp_tokens
for each row execute function public.tokens_guard();
