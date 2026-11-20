begin;

-- Internal until admission and binding recovery can fence pre-resolved accounts.
create function public.make_model_account_private(p_actor uuid, p_account uuid, p_org uuid)
returns uuid
language plpgsql
set search_path = ''
set armada.make_model_account_private = 'on'
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
    and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph')
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

  update public.credentials
  set scope = 'user', owner_id = p_actor, is_default = false
  where id = p_account;

  update public.agent_defaults
  set credential_id = case when credential_id = p_account then null else credential_id end,
      credential_ids = array_remove(credential_ids, p_account)
  where credential_id = p_account or p_account = any(credential_ids);

  return p_account;
end;
$$;
revoke all on function public.make_model_account_private(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.guard_credential_scope_move()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.scope is distinct from old.scope or new.owner_id is distinct from old.owner_id)
    and not (
      old.kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph')
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

commit;
