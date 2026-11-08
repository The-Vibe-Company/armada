-- Sandbox provider identity (#509): every golden and sandbox belongs to exactly one sandbox provider.
-- Never edit a migration that has been applied.
--
-- Additive and backwards compatible:
-- * goldens.provider defaults to boat, and every existing golden and sandbox is backfilled to boat.
-- * The provider's own ids move to neutral columns (provider_sandbox_id, provider_snapshot_id). The
--   boat_* columns stay, for clients of the previous release: on a Boat row they mirror the neutral
--   column in both directions, so an old client writing boat_snapshot_id keeps working. A Modal row never
--   has a boat_* value, so a Modal id is never stored, or read back, as a Boat id.
-- * Ids are unique per provider, never across providers.
-- * A golden's provider is immutable. A sandbox takes its golden's provider; naming another is refused.
-- * A Modal golden pins the workspace, environment and App id its images live in. They are immutable, so
--   a changed local profile or a rotated token of another workspace cannot redirect an existing golden.
--   Only the server (service role) writes a Modal golden; a user JWT reads it.
-- * Golden names are unique per org (or per owner, for private ones) and per provider: a Modal golden may
--   share the name of a Boat golden.

create type public.sandbox_provider as enum ('boat', 'modal');

-- Goldens.

alter table public.goldens
  add column provider public.sandbox_provider not null default 'boat',
  add column provider_sandbox_id text,
  add column provider_snapshot_id text,
  add column modal_workspace text,
  add column modal_environment text,
  add column modal_app_id text;

update public.goldens
set provider_sandbox_id = boat_sandbox_id, provider_snapshot_id = boat_snapshot_id;

alter table public.goldens
  add constraint goldens_provider_ids_chk check (
    (provider_sandbox_id is null or char_length(provider_sandbox_id) between 1 and 200)
    and (provider_snapshot_id is null or char_length(provider_snapshot_id) between 1 and 200)
  ),
  add constraint goldens_provider_compat_chk check (
    (
      provider = 'boat'
      and boat_sandbox_id is not distinct from provider_sandbox_id
      and boat_snapshot_id is not distinct from provider_snapshot_id
    )
    or (provider = 'modal' and boat_sandbox_id is null and boat_snapshot_id is null)
  ),
  add constraint goldens_modal_binding_chk check (
    (
      provider = 'boat'
      and modal_workspace is null
      and modal_environment is null
      and modal_app_id is null
    )
    or (
      provider = 'modal'
      and modal_workspace is not null
      and modal_environment is not null
      and modal_app_id is not null
      and char_length(modal_workspace) between 1 and 200
      and char_length(modal_environment) between 1 and 200
      and char_length(modal_app_id) between 1 and 200
    )
  );

drop index public.goldens_org_name_key;
drop index public.goldens_private_name_key;

create unique index goldens_org_name_key on public.goldens (org_id, provider, name)
  where visibility = 'org';
create unique index goldens_private_name_key on public.goldens (org_id, owner_id, provider, name)
  where visibility = 'private';
create unique index goldens_provider_snapshot_id_key on public.goldens (provider, provider_snapshot_id)
  where provider_snapshot_id is not null;
create unique index goldens_provider_sandbox_id_key on public.goldens (provider, provider_sandbox_id)
  where provider_sandbox_id is not null;

comment on column public.goldens.provider is 'The sandbox provider the golden is built on. Immutable.';
comment on column public.goldens.provider_sandbox_id is
  'The provider''s id of the sandbox the golden is built in. Mirrored by boat_sandbox_id on Boat goldens.';
comment on column public.goldens.provider_snapshot_id is
  'The provider''s snapshot or image reference. Mirrored by boat_snapshot_id on Boat goldens.';
comment on column public.goldens.modal_workspace is 'The Modal workspace a Modal golden is pinned to. Not a secret.';
comment on column public.goldens.modal_environment is 'The Modal environment a Modal golden is pinned to.';
comment on column public.goldens.modal_app_id is 'The Modal App id (not its mutable name) a Modal golden is pinned to.';

-- Keeps the neutral and the boat_* columns of a Boat golden together, and the identity fixed. Runs after
-- goldens_guard (triggers fire in name order).
create function public.goldens_provider_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and (
    new.provider is distinct from old.provider
    or new.modal_workspace is distinct from old.modal_workspace
    or new.modal_environment is distinct from old.modal_environment
    or new.modal_app_id is distinct from old.modal_app_id
  ) then
    raise exception 'golden provider and provider binding are immutable' using errcode = '23514';
  end if;
  -- A Modal golden is built and written by the server alone (service role), which checks the binding against
  -- the workspace of the token it uses. A user JWT cannot create one, pin it to an App of its choosing, or
  -- point an existing one at another image.
  if new.provider = 'modal' and current_user in ('authenticated', 'anon') then
    raise exception 'a Modal golden is written by the Armada server only' using errcode = '42501';
  end if;
  if new.provider = 'boat' then
    if tg_op = 'INSERT' then
      new.provider_sandbox_id := coalesce(new.provider_sandbox_id, new.boat_sandbox_id);
      new.boat_sandbox_id := new.provider_sandbox_id;
      new.provider_snapshot_id := coalesce(new.provider_snapshot_id, new.boat_snapshot_id);
      new.boat_snapshot_id := new.provider_snapshot_id;
    else
      if new.provider_sandbox_id is distinct from old.provider_sandbox_id then
        new.boat_sandbox_id := new.provider_sandbox_id;
      elsif new.boat_sandbox_id is distinct from old.boat_sandbox_id then
        new.provider_sandbox_id := new.boat_sandbox_id;
      end if;
      if new.provider_snapshot_id is distinct from old.provider_snapshot_id then
        new.boat_snapshot_id := new.provider_snapshot_id;
      elsif new.boat_snapshot_id is distinct from old.boat_snapshot_id then
        new.provider_snapshot_id := new.boat_snapshot_id;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger goldens_provider_guard
before insert or update on public.goldens
for each row execute function public.goldens_provider_guard();

-- Sandboxes.

alter table public.sandboxes
  add column provider public.sandbox_provider,
  add column provider_sandbox_id text;

update public.sandboxes set provider = 'boat', provider_sandbox_id = boat_id;

alter table public.sandboxes
  alter column provider set not null,
  alter column provider_sandbox_id set not null,
  alter column boat_id drop not null,
  add constraint sandboxes_provider_sandbox_id_chk check (char_length(provider_sandbox_id) between 1 and 200),
  add constraint sandboxes_provider_compat_chk check (
    (provider = 'boat' and boat_id is not distinct from provider_sandbox_id)
    or (provider = 'modal' and boat_id is null)
  );

create unique index sandboxes_provider_sandbox_id_key on public.sandboxes (provider, provider_sandbox_id);

comment on column public.sandboxes.provider is 'The sandbox provider, always its golden''s. Immutable.';
comment on column public.sandboxes.provider_sandbox_id is
  'The provider''s id of the sandbox. Mirrored by boat_id on Boat sandboxes; boat_id is null on others.';

-- The provider comes from the golden: left out it is filled in, and any other value is refused. On a Boat
-- sandbox boat_id and provider_sandbox_id are one id, whichever of the two a client wrote.
create function public.sandboxes_provider_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  golden_provider public.sandbox_provider;
begin
  select provider into golden_provider from public.goldens where id = new.golden_id;
  if not found then
    raise exception 'sandbox golden does not exist' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    if new.provider is null then
      new.provider := golden_provider;
    elsif new.provider is distinct from golden_provider then
      raise exception 'a sandbox runs on its golden''s provider (%)', golden_provider using errcode = '23514';
    end if;
    if new.provider = 'boat' then
      new.provider_sandbox_id := coalesce(new.provider_sandbox_id, new.boat_id);
      new.boat_id := new.provider_sandbox_id;
    end if;
  elsif new.provider is distinct from old.provider
    or new.provider_sandbox_id is distinct from old.provider_sandbox_id then
    raise exception 'sandbox identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sandboxes_provider_guard
before insert or update on public.sandboxes
for each row execute function public.sandboxes_provider_guard();

-- Credentials: a Modal token pair is one row, so its id and secret are always read from the same scope.
alter type public.credential_kind add value if not exists 'modal';

-- A user JWT inserts every column already (table grant). It may move the neutral ids the way it moves the
-- boat_* ones; provider and the Modal binding are fixed at insert.
grant update (provider_sandbox_id, provider_snapshot_id) on public.goldens to authenticated;

-- Only the server registers Modal handles. A browser must not point a trusted golden at an arbitrary
-- physical machine. This restrictive policy also checks provider values filled by the BEFORE trigger;
-- service_role bypasses RLS, while old Boat clients keep their existing insert path.
create policy sandboxes_modal_server_insert on public.sandboxes
  as restrictive for insert to authenticated
  with check (provider = 'boat');
