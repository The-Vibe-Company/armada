begin;

-- Keep owner existence checks privileged for ordinary credential writes.
create or replace function public.credentials_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
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
    or new.kind is distinct from old.kind
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'credential identity may not change' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Scope and owner changes are reserved for the protected transaction. Check
-- the invoking role as well as the transaction's function-local setting.
create function public.guard_credential_scope_move()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.scope is distinct from old.scope or new.owner_id is distinct from old.owner_id)
    and not (
      coalesce(current_setting('armada.share_model_account', true), '') = 'on'
      and current_user is not distinct from (
        select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
        where oid = 'public.share_model_account(uuid,uuid,uuid)'::pg_catalog.regprocedure
      )
      and old.scope = 'user' and new.scope = 'org'
      and old.kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph')
    ) then
    raise exception 'credential scope may change only through the protected transaction' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_credential_scope_move() from public, anon, authenticated, service_role;

create trigger guard_credential_scope_move
before update on public.credentials
for each row execute function public.guard_credential_scope_move();

-- Internal transaction. Keep it ungranted until launch admission rechecks
-- scope under the credential lock for bindings resolved before this call.
create function public.share_model_account(p_actor uuid, p_account uuid, p_org uuid)
returns uuid
language plpgsql
set search_path = ''
set armada.share_model_account = 'on'
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
    and kind in ('claude_oauth','anthropic','openai','codex_auth','opencode','morph')
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

  update public.credentials
  set scope = 'org', owner_id = p_org, is_default = false
  where id = p_account;

  update public.agent_defaults
  set credential_id = case when credential_id = p_account then null else credential_id end,
      credential_ids = array_remove(credential_ids, p_account)
  where credential_id = p_account or p_account = any(credential_ids);

  return p_account;
end;
$$;
revoke all on function public.share_model_account(uuid, uuid, uuid) from public, anon, authenticated, service_role;

commit;
