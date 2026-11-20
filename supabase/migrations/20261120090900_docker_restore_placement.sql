begin;

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
      (new.provider, new.docker_host_id, new.docker_installation_id, new.docker_image)
      is distinct from
      (old.provider, old.docker_host_id, old.docker_installation_id, old.docker_image)
    ) then
      raise exception 'sandbox identity is immutable' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE'
      and (new.docker_generation, new.provider_sandbox_id) is distinct from
        (old.docker_generation, old.provider_sandbox_id) then
      if old.status <> 'starting' or new.status <> 'starting'
        or new.lifecycle_generation is distinct from old.lifecycle_generation
        or new.docker_generation is not distinct from old.docker_generation
        or new.provider_sandbox_id is distinct from
          concat('armada-', old.docker_installation_id, '-', old.docker_host_id, '-', old.id, '-', new.docker_generation)
        or not exists (
          select 1
          from public.docker_machine_bindings target
          join public.docker_machine_bindings source
            on source.sandbox_id = target.sandbox_id and source.host_id = target.host_id
            and source.installation_id = target.installation_id and source.machine_generation < target.machine_generation
          join public.docker_host_jobs receipt
            on receipt.request_id = target.daemon_generation and receipt.host_id = target.host_id
            and receipt.bound_sandbox_id = target.sandbox_id and receipt.bound_operation = 'restore'
            and receipt.outcome = 'completed' and receipt.cancelled_at is null
          where target.sandbox_id = old.id and target.host_id = old.docker_host_id
            and target.installation_id = old.docker_installation_id
            and target.machine_generation = old.lifecycle_generation
            and target.daemon_generation = new.docker_generation and source.daemon_generation = old.docker_generation
        ) then
        raise exception 'Docker placement must match a completed restore' using errcode = '23514';
      end if;
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

commit;
