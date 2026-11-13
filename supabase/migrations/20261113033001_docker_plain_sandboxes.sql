-- Dark, service-owned plain-image records only; no Docker golden or launch API.
alter table public.docker_hosts add constraint docker_hosts_id_org_key unique (id, org_id);
alter table public.sandboxes
  add column docker_host_id uuid,
  add column docker_installation_id uuid,
  add column docker_generation uuid,
  add column docker_image text,
  alter column golden_id drop not null,
  alter column source_golden_visibility drop not null,
  drop constraint sandboxes_provider_compat_chk,
  add constraint sandboxes_provider_compat_chk check (
    (provider = 'boat' and boat_id is not distinct from provider_sandbox_id)
    or (provider in ('modal', 'docker') and boat_id is null)
  ),
  add constraint sandboxes_docker_host_fk foreign key (docker_host_id, org_id)
    references public.docker_hosts(id, org_id),
  add constraint sandboxes_golden_source_chk check (
    (provider in ('boat', 'modal') and golden_id is not null and source_golden_visibility is not null)
    or (provider = 'docker' and golden_id is null and source_golden_visibility is null)
  ),
  add constraint sandboxes_docker_binding_chk check (
    (provider <> 'docker' and docker_host_id is null and docker_installation_id is null
      and docker_generation is null and docker_image is null)
    or (provider = 'docker' and docker_host_id is not null and docker_installation_id is not null
      and docker_generation is not null and docker_image is not null
      and char_length(docker_image) <= 512
      and docker_image ~ '^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$'
      and harness = 'codex' and visibility = 'private' and access_owner_id = owner_id
      and not boat_runtime and repository_dir is null and expires_at is not null)
  );
-- Binding metadata is intentionally readable under existing owner/admin RLS.
-- Keep legacy table SELECT for dashboard SELECT *; writes remain trigger-fenced.
revoke all (docker_host_id, docker_installation_id, docker_generation, docker_image)
  on public.sandboxes from public, anon, authenticated;
grant select (docker_host_id, docker_installation_id, docker_generation, docker_image)
  on public.sandboxes to authenticated;

create or replace function public.sandboxes_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  golden public.goldens;
begin
  if new.provider is distinct from 'docker' then
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

create or replace function public.sandboxes_provider_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  golden_provider public.sandbox_provider;
  host public.docker_hosts;
  host_owner uuid;
  member_ids uuid[];
begin
  -- role retains the caller even when a SECURITY DEFINER RPC invokes this trigger.
  if (case when tg_op = 'DELETE' then old.provider = 'docker'
      else new.provider = 'docker' end)
    or (tg_op = 'UPDATE' and old.provider = 'docker') then
    if current_setting('role', true) in ('authenticated', 'anon') then
      raise exception 'Docker sandboxes are written by the Armada server only' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'UPDATE' and (
      (new.provider, new.provider_sandbox_id, new.docker_host_id, new.docker_installation_id,
       new.docker_generation, new.docker_image)
      is distinct from
      (old.provider, old.provider_sandbox_id, old.docker_host_id, old.docker_installation_id,
       old.docker_generation, old.docker_image)
    ) then
      raise exception 'sandbox identity is immutable' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' then
      if new.expires_at is null or new.expires_at <= now() then
        raise exception 'Docker sandbox expiry must be in the future' using errcode = '23514';
      end if;
      -- Match the host store's member-before-host lock order. The unlocked issuer
      -- lookup is only a candidate; revalidate that binding under the host lock.
      select owner_id into host_owner from public.docker_hosts
        where id = new.docker_host_id and org_id = new.org_id;
      if not found then raise exception 'Docker host unavailable' using errcode = '23514'; end if;
      select array_agg(locked.user_id) into member_ids from (
        select user_id from public.members where org_id = new.org_id
          and user_id in (host_owner, new.owner_id) order by user_id for share
      ) locked;
      if not coalesce(host_owner = any(member_ids), false) then
        raise exception 'Docker host issuer is not a member' using errcode = '23514';
      end if;
      if not coalesce(new.owner_id = any(member_ids), false) then
        raise exception 'Docker sandbox owner is not a member' using errcode = '23514';
      end if;
      -- Registration deadlines govern unused codes, not registered credentials.
      select * into host from public.docker_hosts
        where id = new.docker_host_id and org_id = new.org_id and owner_id = host_owner
          and installation_id = new.docker_installation_id for share;
      if not found or host.revoked_at is not null or host.hash is null or host.registration_hash is not null then
        raise exception 'Docker host unavailable' using errcode = '23514';
      end if;
      if new.provider_sandbox_id is distinct from
        'armada-' || new.docker_installation_id || '-' || new.docker_host_id || '-' || new.id || '-' || new.docker_generation then
        raise exception 'Docker sandbox name must match its binding' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then return old; end if;
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

-- DELETE has no prior provider trigger; preserve other providers unchanged.
create trigger sandboxes_docker_delete_guard before delete on public.sandboxes
for each row execute function public.sandboxes_provider_guard();

create or replace function public.sandbox_visibility_default() returns trigger language plpgsql set search_path = public as $$
begin
 if new.provider = 'docker' then
  new.visibility := coalesce(new.visibility, 'private'::public.visibility);
  new.access_owner_id := coalesce(new.access_owner_id, new.owner_id);
  return new;
 end if;
 if new.visibility is null then
  select visibility into new.visibility from public.goldens where id = new.golden_id;
 end if;
 select visibility into new.source_golden_visibility from public.goldens where id = new.golden_id;
 new.access_owner_id := coalesce(new.access_owner_id, new.owner_id);
 return new;
end $$;
