-- Functions the dashboard calls with a user JWT for the writes row level security
-- cannot express: creating an org (there is no insert policy on orgs), listing
-- and adding members by email (auth.users is not readable by a user), and
-- changing the visibility of a golden (immutable by a plain update).
-- Each one checks auth.uid() itself, because security definer bypasses RLS.
--
-- Runs after 20261108130000_oauth.sql and 20261108140000_golden_sandbox.sql.
-- Replacing goldens_guard keeps boat_sandbox_id, name, config and boat_snapshot_id
-- writable: only id, org, visibility, owner and created_at stay immutable, and
-- visibility changes only through set_golden_visibility. oauth_clients and
-- oauth_codes stay service_role only; this migration grants them nothing.

-- Creates an org and makes the caller its first admin.
create function public.create_org(org_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to create an org' using errcode = '28000';
  end if;
  insert into public.orgs (name) values (btrim(org_name)) returning id into new_org;
  insert into public.members (org_id, user_id, role) values (new_org, auth.uid(), 'admin');
  return new_org;
end;
$$;

-- The members of an org with their email, for the members of that org only.
create function public.org_members(target_org uuid)
returns table (user_id uuid, email text, role public.member_role, created_at timestamptz)
language sql
stable
security definer
set search_path = public, auth
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.members m
  join auth.users u on u.id = m.user_id
  where m.org_id = target_org and public.is_org_member(target_org)
  order by m.created_at, u.email;
$$;

-- Adds an existing account to an org, by email. Admin only.
create function public.add_org_member(target_org uuid, member_email text, member_role public.member_role)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_user uuid;
begin
  if not public.is_org_admin(target_org) then
    raise exception 'only an org admin adds members' using errcode = '42501';
  end if;
  select id into target_user from auth.users where lower(email) = lower(btrim(member_email));
  if target_user is null then
    raise exception 'no account for that email: the person signs in to Armada once first' using errcode = 'P0002';
  end if;
  insert into public.members (org_id, user_id, role) values (target_org, target_user, member_role);
  return target_user;
end;
$$;

-- goldens_guard keeps visibility immutable. set_golden_visibility is the one way through:
-- it names the golden in a transaction-local setting the guard checks.
create or replace function public.goldens_guard()
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
    or (
      new.visibility is distinct from old.visibility
      and coalesce(current_setting('armada.golden_visibility_change', true), '') is distinct from old.id::text
    )
    or new.owner_id is distinct from old.owner_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'golden id, org, visibility, owner and created_at are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Only the owner changes the visibility of a golden. Sharing it with the org takes an admin
-- (only an admin owns an org golden); making it private is refused while another member
-- still has a sandbox of it, since a private sandbox belongs to the golden owner.
create function public.set_golden_visibility(target_golden uuid, new_visibility public.visibility)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  golden public.goldens;
begin
  select * into golden from public.goldens where id = target_golden;
  if not found or golden.owner_id is distinct from auth.uid() or not public.is_org_member(golden.org_id) then
    raise exception 'golden not found' using errcode = 'P0002';
  end if;
  if golden.visibility = new_visibility then
    return;
  end if;
  if new_visibility = 'org' and not public.is_org_admin(golden.org_id) then
    raise exception 'only an org admin shares a golden with the org' using errcode = '42501';
  end if;
  if new_visibility = 'private' and exists (
    select 1 from public.sandboxes where golden_id = golden.id and owner_id is distinct from golden.owner_id
  ) then
    raise exception 'other members still have sandboxes of this golden' using errcode = '23514';
  end if;
  perform set_config('armada.golden_visibility_change', golden.id::text, true);
  update public.goldens set visibility = new_visibility where id = golden.id;
  perform set_config('armada.golden_visibility_change', '', true);
end;
$$;

revoke all on function public.create_org(text) from public;
revoke all on function public.org_members(uuid) from public;
revoke all on function public.add_org_member(uuid, text, public.member_role) from public;
revoke all on function public.set_golden_visibility(uuid, public.visibility) from public;
grant execute on function public.create_org(text) to authenticated, service_role;
grant execute on function public.org_members(uuid) to authenticated, service_role;
grant execute on function public.add_org_member(uuid, text, public.member_role) to authenticated, service_role;
grant execute on function public.set_golden_visibility(uuid, public.visibility) to authenticated, service_role;
