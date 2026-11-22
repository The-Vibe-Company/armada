begin;

-- The deployed vault writer uses this provider-only conflict predicate.
drop index public.credentials_provider_singleton;
create unique index credentials_provider_singleton on public.credentials(scope, owner_id, kind)
where kind in ('boat','modal','skillpack');

alter table public.credentials drop constraint credentials_nonmodel_default_chk,
  add constraint credentials_nonmodel_default_chk
  check (not is_default or kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph','antigravity'));

drop index public.credentials_harness_default;
create unique index credentials_harness_default on public.credentials(scope, owner_id,
  (case
    when kind in ('claude_oauth','anthropic') then 'claude'
    when kind = 'opencode' then 'opencode'
    when kind = 'morph' then 'morph'
    when kind = 'antigravity' then 'antigravity'
    else 'codex'
  end))
where is_default and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph','antigravity');

-- Preserve ownership and grants on the protected account transactions.
create or replace function public.share_model_account(p_actor uuid, p_account uuid, p_org uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_kind public.credential_kind;
begin
  -- Match both existing vault owner locks and order the two keys consistently.
  perform pg_advisory_xact_lock(least(hashtextextended(p_actor::text, 0), hashtextextended(p_org::text, 0)));
  perform pg_advisory_xact_lock(greatest(hashtextextended(p_actor::text, 0), hashtextextended(p_org::text, 0)));

  perform 1 from public.members
  where org_id = p_org and user_id = p_actor and role = 'admin' for share;
  if not found then
    raise exception 'Only an organization admin can share an account there.' using errcode = '42501';
  end if;

  select kind into v_kind from public.credentials
  where id = p_account and scope = 'user' and owner_id = p_actor and status <> 'deleted'
    and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph','antigravity')
  for update;
  if not found then
    raise exception 'No such personal model account.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.credentials
    where scope = 'org' and owner_id = p_org and kind = v_kind and status <> 'deleted'
  ) then
    raise exception 'The organization already has an account of this kind. Choose another organization or remove the conflicting account.'
      using errcode = '23505';
  end if;

  if exists (
    select 1 from public.sandboxes
    where credential_id = p_account and deleted_at is null and org_id <> p_org
  ) or exists (
    select 1 from public.account_agent_reservations r
    where r.account_id = p_account and not exists (
      select 1 from public.sandboxes s where s.id = r.sandbox_id and s.org_id = p_org
    )
  ) then
    raise exception 'An agent outside the destination organization or a pending launch still uses this account.'
      using errcode = '55000';
  end if;

  perform pg_catalog.set_config('armada.share_model_account', 'on', true);
  update public.credentials
  set scope = 'org', owner_id = p_org, is_default = false
  where id = p_account;
  perform pg_catalog.set_config('armada.share_model_account', '', true);

  update public.agent_defaults
  set credential_id = case when credential_id = p_account then null else credential_id end,
      credential_ids = array_remove(credential_ids, p_account)
  where credential_id = p_account or p_account = any(credential_ids);

  return p_account;
end;
$$;

create or replace function public.make_model_account_private(p_actor uuid, p_account uuid, p_org uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_kind public.credential_kind;
begin
  -- Use the same lock order as sharing and the existing vault writes.
  perform pg_advisory_xact_lock(least(hashtextextended(p_actor::text, 0), hashtextextended(p_org::text, 0)));
  perform pg_advisory_xact_lock(greatest(hashtextextended(p_actor::text, 0), hashtextextended(p_org::text, 0)));

  perform 1 from public.members
  where org_id = p_org and user_id = p_actor and role = 'admin' for share;
  if not found then
    raise exception 'Only an organization admin can make an organization account private.' using errcode = '42501';
  end if;

  select kind into v_kind from public.credentials
  where id = p_account and scope = 'org' and owner_id = p_org and status <> 'deleted'
    and created_by = p_actor
    and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph','antigravity')
  for update;
  if not found then
    raise exception 'No organization model account with you as its verified creator.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.credentials
    where scope = 'user' and owner_id = p_actor and kind = v_kind and status <> 'deleted'
  ) then
    raise exception 'You already have a personal account of this kind. Remove the conflicting account before making this one private.'
      using errcode = '23505';
  end if;

  if exists (
    select 1 from public.sandboxes
    where credential_id = p_account and deleted_at is null and owner_id is distinct from p_actor
  ) or exists (
    select 1 from public.account_agent_reservations where account_id = p_account
  ) then
    raise exception 'Another sandbox owner or a pending launch still uses this account.' using errcode = '55000';
  end if;

  perform pg_catalog.set_config('armada.make_model_account_private', 'on', true);
  update public.credentials
  set scope = 'user', owner_id = p_actor, is_default = false
  where id = p_account;
  perform pg_catalog.set_config('armada.make_model_account_private', '', true);

  update public.agent_defaults
  set credential_id = case when credential_id = p_account then null else credential_id end,
      credential_ids = array_remove(credential_ids, p_account)
  where credential_id = p_account or p_account = any(credential_ids);

  return p_account;
end;
$$;

create or replace function public.guard_credential_scope_move()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.scope is distinct from old.scope or new.owner_id is distinct from old.owner_id)
    and not (
      old.kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph','antigravity')
      and (
        (
          old.scope = 'user' and new.scope = 'org'
          and coalesce(current_setting('armada.share_model_account', true), '') = 'on'
          and current_user is not distinct from (
            select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
            where oid = 'public.share_model_account(uuid,uuid,uuid)'::pg_catalog.regprocedure
          )
        ) or (
          old.scope = 'org' and new.scope = 'user'
          and coalesce(current_setting('armada.make_model_account_private', true), '') = 'on'
          and current_user is not distinct from (
            select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
            where oid = 'public.make_model_account_private(uuid,uuid,uuid)'::pg_catalog.regprocedure
          )
        )
      )
    ) then
    raise exception 'credential scope may change only through the protected transaction' using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table public.sandboxes drop constraint sandboxes_runtime_transport_target;
alter table public.sandboxes add constraint sandboxes_runtime_transport_target check (
  runtime_transport is null or (
    runtime_transport = 'dialout' and provider = 'modal'
    and harness in ('codex', 'claude', 'opencode', 'antigravity') and not boat_runtime
  )
);

alter table public.sandboxes drop constraint sandboxes_docker_binding_chk,
  add constraint sandboxes_docker_binding_chk check (
    (provider <> 'docker' and docker_host_id is null and docker_installation_id is null
      and docker_generation is null and docker_image is null)
    or (provider = 'docker' and docker_host_id is not null and docker_installation_id is not null
      and docker_generation is not null and docker_image is not null
      and char_length(docker_image) <= 512
      and docker_image ~ '^(sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64})$'
      and harness in ('codex', 'claude', 'opencode', 'antigravity') and visibility = 'private' and access_owner_id = owner_id
      and not boat_runtime and repository_dir is null and expires_at is not null)
  );

alter table public.agent_defaults drop constraint agent_defaults_harness_check,
  add constraint agent_defaults_harness_check check (harness in ('claude','codex','opencode','antigravity'));

alter table public.triggers drop constraint triggers_pool_harness_check,
  add constraint triggers_pool_harness_check check (pool_harness in ('claude','codex','opencode','antigravity'));

commit;
