-- Row level security. authenticated is the signed-in user (auth.uid()). service_role
-- bypasses RLS and is the only role that can read ciphertext columns.
--
-- Reads: a member sees org-visible resources of their orgs. A private resource
-- is visible only to its owner, and only while they are still a member. Admins
-- are not exempt.
-- Writes: only an admin changes an org golden, the membership, the org, or an
-- org key. The owner changes their private golden and their user credentials.
-- Any member may launch and stop an org sandbox; only the owner may touch a
-- private one. Sandbox rows are not hard-deleted by a user JWT (set status
-- deleted). Creating an org, and inserting its first admin, is service_role:
-- there is no insert policy on orgs.

alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.credentials enable row level security;
alter table public.goldens enable row level security;
alter table public.sandboxes enable row level security;
alter table public.notify_subscriptions enable row level security;
alter table public.service_tokens enable row level security;
alter table public.mcp_tokens enable row level security;

create function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where org_id = target_org and user_id = auth.uid()
  );
$$;

create function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where org_id = target_org and user_id = auth.uid() and role = 'admin'
  );
$$;

-- Private rows also require current membership, so a removed member loses them.
create function public.can_read_golden(target_org uuid, target_visibility public.visibility, target_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case target_visibility
    when 'org' then public.is_org_member(target_org)
    when 'private' then target_owner = auth.uid() and public.is_org_member(target_org)
    else false
  end;
$$;

create function public.owns_token(token_user uuid, token_org uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select token_user = auth.uid() and public.is_org_member(token_org);
$$;

revoke all on all functions in schema public from public;
grant execute on all functions in schema public to authenticated, service_role;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

grant usage on schema public to authenticated, service_role;

-- Ciphertext columns are writable by a user JWT and readable only by service_role.
grant select (id, name, created_at), update (name, boat_api_key_enc), delete on public.orgs to authenticated;
grant select, insert, update, delete on public.orgs to service_role;

grant select, insert (org_id, user_id, role, created_at), update (role), delete on public.members to authenticated;
grant select, insert, update, delete on public.members to service_role;

grant select (id, scope, owner_id, kind, created_at),
  insert (id, scope, owner_id, kind, value_enc, created_at),
  update (value_enc),
  delete
  on public.credentials to authenticated;
grant select, insert, update, delete on public.credentials to service_role;

grant select, insert,
  update (name, boat_snapshot_id, config),
  delete
  on public.goldens to authenticated;
grant select, insert, update, delete on public.goldens to service_role;

grant select, insert,
  update (status, conversation_ids, stopped_at, deleted_at)
  on public.sandboxes to authenticated;
grant select, insert, update, delete on public.sandboxes to service_role;

grant select (sandbox_id, url, last_cursor, last_status, created_at),
  insert (sandbox_id, url, secret_enc, last_cursor, last_status, created_at),
  update (url, secret_enc, last_cursor, last_status),
  delete
  on public.notify_subscriptions to authenticated;
grant select, insert, update, delete on public.notify_subscriptions to service_role;

grant select, insert, update (revoked_at), delete on public.service_tokens to authenticated;
grant select, insert, update, delete on public.service_tokens to service_role;

grant select, insert, update (revoked_at), delete on public.mcp_tokens to authenticated;
grant select, insert, update, delete on public.mcp_tokens to service_role;

-- Later migrations run as the same owner. New tables are not granted to
-- authenticated until that migration says so, so a new ciphertext column is
-- not readable by a user JWT by default. service_role keeps full access.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

create policy orgs_select on public.orgs
for select to authenticated
using (public.is_org_member(id));

create policy orgs_update on public.orgs
for update to authenticated
using (public.is_org_admin(id))
with check (public.is_org_admin(id));

create policy orgs_delete on public.orgs
for delete to authenticated
using (public.is_org_admin(id));

create policy members_select on public.members
for select to authenticated
using (public.is_org_member(org_id));

create policy members_insert on public.members
for insert to authenticated
with check (public.is_org_admin(org_id));

create policy members_update on public.members
for update to authenticated
using (public.is_org_admin(org_id))
with check (public.is_org_admin(org_id));

create policy members_delete on public.members
for delete to authenticated
using (public.is_org_admin(org_id));

create policy credentials_select on public.credentials
for select to authenticated
using (
  (scope = 'user' and owner_id = auth.uid())
  or (scope = 'org' and public.is_org_member(owner_id))
);

create policy credentials_insert on public.credentials
for insert to authenticated
with check (
  (scope = 'user' and owner_id = auth.uid())
  or (scope = 'org' and public.is_org_admin(owner_id))
);

create policy credentials_update on public.credentials
for update to authenticated
using (
  (scope = 'user' and owner_id = auth.uid())
  or (scope = 'org' and public.is_org_admin(owner_id))
)
with check (
  (scope = 'user' and owner_id = auth.uid())
  or (scope = 'org' and public.is_org_admin(owner_id))
);

create policy credentials_delete on public.credentials
for delete to authenticated
using (
  (scope = 'user' and owner_id = auth.uid())
  or (scope = 'org' and public.is_org_admin(owner_id))
);

create policy goldens_select on public.goldens
for select to authenticated
using (public.can_read_golden(org_id, visibility, owner_id));

create policy goldens_insert on public.goldens
for insert to authenticated
with check (
  owner_id = auth.uid()
  and public.is_org_member(org_id)
  and (visibility = 'private' or public.is_org_admin(org_id))
);

create policy goldens_update on public.goldens
for update to authenticated
using (
  (visibility = 'org' and public.is_org_admin(org_id))
  or (visibility = 'private' and owner_id = auth.uid() and public.is_org_member(org_id))
)
with check (
  (visibility = 'org' and public.is_org_admin(org_id))
  or (visibility = 'private' and owner_id = auth.uid() and public.is_org_member(org_id))
);

create policy goldens_delete on public.goldens
for delete to authenticated
using (
  (visibility = 'org' and public.is_org_admin(org_id))
  or (visibility = 'private' and owner_id = auth.uid() and public.is_org_member(org_id))
);

create policy sandboxes_select on public.sandboxes
for select to authenticated
using (
  exists (
    select 1 from public.goldens
    where goldens.id = sandboxes.golden_id
      and public.can_read_golden(goldens.org_id, goldens.visibility, goldens.owner_id)
  )
);

create policy sandboxes_insert on public.sandboxes
for insert to authenticated
with check (
  owner_id = auth.uid()
  and exists (
    select 1 from public.goldens
    where goldens.id = sandboxes.golden_id
      and goldens.org_id = sandboxes.org_id
      and public.can_read_golden(goldens.org_id, goldens.visibility, goldens.owner_id)
  )
);

create policy sandboxes_update on public.sandboxes
for update to authenticated
using (
  exists (
    select 1 from public.goldens
    where goldens.id = sandboxes.golden_id
      and public.can_read_golden(goldens.org_id, goldens.visibility, goldens.owner_id)
  )
)
with check (
  exists (
    select 1 from public.goldens
    where goldens.id = sandboxes.golden_id
      and goldens.org_id = sandboxes.org_id
      and public.can_read_golden(goldens.org_id, goldens.visibility, goldens.owner_id)
  )
);

create policy notify_select on public.notify_subscriptions
for select to authenticated
using (exists (select 1 from public.sandboxes where sandboxes.id = notify_subscriptions.sandbox_id));

create policy notify_insert on public.notify_subscriptions
for insert to authenticated
with check (exists (select 1 from public.sandboxes where sandboxes.id = notify_subscriptions.sandbox_id));

create policy notify_update on public.notify_subscriptions
for update to authenticated
using (exists (select 1 from public.sandboxes where sandboxes.id = notify_subscriptions.sandbox_id))
with check (exists (select 1 from public.sandboxes where sandboxes.id = notify_subscriptions.sandbox_id));

create policy notify_delete on public.notify_subscriptions
for delete to authenticated
using (exists (select 1 from public.sandboxes where sandboxes.id = notify_subscriptions.sandbox_id));

create policy service_tokens_select on public.service_tokens
for select to authenticated
using (public.owns_token(user_id, org_id));

create policy service_tokens_insert on public.service_tokens
for insert to authenticated
with check (public.owns_token(user_id, org_id));

create policy service_tokens_update on public.service_tokens
for update to authenticated
using (public.owns_token(user_id, org_id))
with check (public.owns_token(user_id, org_id));

create policy service_tokens_delete on public.service_tokens
for delete to authenticated
using (public.owns_token(user_id, org_id));

create policy mcp_tokens_select on public.mcp_tokens
for select to authenticated
using (public.owns_token(user_id, org_id));

create policy mcp_tokens_insert on public.mcp_tokens
for insert to authenticated
with check (public.owns_token(user_id, org_id));

create policy mcp_tokens_update on public.mcp_tokens
for update to authenticated
using (public.owns_token(user_id, org_id))
with check (public.owns_token(user_id, org_id));

create policy mcp_tokens_delete on public.mcp_tokens
for delete to authenticated
using (public.owns_token(user_id, org_id));
