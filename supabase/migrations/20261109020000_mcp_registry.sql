-- One effective state predicate for DTOs and all grant authorization boundaries.
create function public.mcp_grant_effective_status(current_status text, revoked timestamptz, consumed boolean, refresh_deadline timestamptz)
returns text language sql stable set search_path=public as $$
 select case when revoked is not null then 'not_connected'
 when consumed and (refresh_deadline is null or refresh_deadline<=now()) then 'needs_reconnect'
 else current_status end;
$$;
revoke all on function public.mcp_grant_effective_status(text,timestamptz,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.mcp_grant_effective_status(text,timestamptz,boolean,timestamptz) to service_role;

-- Snapshot legacy visibility, preserving the golden-owner boundary for old private forks.
alter table public.sandboxes add column visibility public.visibility;
alter table public.sandboxes add column source_golden_visibility public.visibility;
alter table public.sandboxes add column access_owner_id uuid references auth.users(id);
update public.sandboxes s set visibility = g.visibility, source_golden_visibility = g.visibility,
 access_owner_id = case when g.visibility = 'private' then g.owner_id else s.owner_id end
from public.goldens g where g.id = s.golden_id;
alter table public.sandboxes alter column visibility set not null;
alter table public.sandboxes alter column source_golden_visibility set not null;
alter table public.sandboxes alter column access_owner_id set not null;
create function public.sandbox_visibility_default() returns trigger language plpgsql set search_path = public as $$
begin
 if new.visibility is null then
  select visibility into new.visibility from public.goldens where id = new.golden_id;
 end if;
 select visibility into new.source_golden_visibility from public.goldens where id = new.golden_id;
 new.access_owner_id := coalesce(new.access_owner_id, new.owner_id);
 return new;
end $$;
create trigger sandbox_visibility_default before insert on public.sandboxes for each row execute function public.sandbox_visibility_default();
revoke all on function public.sandbox_visibility_default() from public, anon, authenticated;
drop policy sandboxes_select on public.sandboxes;
drop policy sandboxes_insert on public.sandboxes;
drop policy sandboxes_update on public.sandboxes;
create policy sandboxes_select on public.sandboxes for select to authenticated
using (public.can_read_golden(org_id, visibility, access_owner_id));
create policy sandboxes_update on public.sandboxes for update to authenticated
using (public.can_read_golden(org_id, visibility, access_owner_id))
with check (public.can_read_golden(org_id, visibility, access_owner_id));
create policy sandboxes_insert on public.sandboxes for insert to authenticated with check (
 owner_id = auth.uid() and access_owner_id = auth.uid() and public.is_org_member(org_id)
 and exists(select 1 from public.goldens g where g.id = golden_id and g.org_id = sandboxes.org_id
 and public.can_read_golden(g.org_id,g.visibility,g.owner_id)
 and (g.visibility = 'org' or sandboxes.visibility = 'private')));
grant select(visibility,access_owner_id), insert(visibility,access_owner_id) on public.sandboxes to authenticated;

create table public.mcp_connections (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
 owner_id uuid not null references auth.users(id), scope text not null check(scope in ('personal','org')),
 name text not null check(length(name) between 1 and 200),
 transport text not null check(transport in ('http','sse','stdio')),
 url text, command text, args jsonb not null default '[]',
 auth_type text not null check(auth_type in ('auto','none','bearer','headers','oauth')),
 disabled boolean not null default false, created_at timestamptz not null default now(),
 check ((transport = 'stdio' and command is not null and url is null) or (transport <> 'stdio' and url is not null and command is null))
);
create table public.mcp_grants (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null unique references public.mcp_connections(id) on delete cascade,
 value_enc bytea, generation integer not null default 1, version integer not null default 1,
 status text not null default 'not_connected' check(status in ('connected','not_connected','needs_reconnect','unavailable','disabled')),
 account_label text, revoked_at timestamptz, refresh_owner uuid, refresh_until timestamptz
);
create table public.mcp_bindings (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 connection_id uuid not null references public.mcp_connections(id) on delete cascade,
 grant_id uuid not null references public.mcp_grants(id) on delete cascade,
 primary key(sandbox_id,connection_id)
);
create table public.mcp_leases (
 id uuid primary key default gen_random_uuid(), sandbox_id uuid not null,
 connection_id uuid not null, grant_id uuid not null references public.mcp_grants(id) on delete cascade,
 org_id uuid not null references public.orgs(id), owner_id uuid not null references auth.users(id),
 generation integer not null, sandbox_generation integer not null,
 hash text not null unique, operations text[] not null, expires_at timestamptz not null, revoked_at timestamptz,
 foreign key(sandbox_id,connection_id) references public.mcp_bindings(sandbox_id,connection_id) on delete cascade
);
alter table public.sandboxes add column mcp_generation integer not null default 1;
-- Bindings and leases are service-controlled, never writable/readable using a user JWT.
alter table public.mcp_connections enable row level security;
alter table public.mcp_grants enable row level security;
alter table public.mcp_bindings enable row level security;
alter table public.mcp_leases enable row level security;
revoke all on public.mcp_connections,public.mcp_grants,public.mcp_bindings,public.mcp_leases from anon,authenticated;
grant all on public.mcp_connections,public.mcp_grants,public.mcp_bindings,public.mcp_leases to service_role;
grant select on public.mcp_connections to authenticated;
create policy mcp_connections_select on public.mcp_connections for select to authenticated
using (public.is_org_member(org_id) and (scope = 'org' or owner_id = auth.uid()));

create function public.check_mcp_binding() returns trigger language plpgsql set search_path = public as $$
begin
 if not exists(select 1 from public.sandboxes s join public.mcp_connections c on c.org_id = s.org_id
 join public.mcp_grants g on g.connection_id = c.id
 where s.id = new.sandbox_id and c.id = new.connection_id and g.id = new.grant_id
 and not c.disabled and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until) = 'connected'
 and exists(select 1 from public.members m where m.org_id = s.org_id and m.user_id = s.owner_id)
 and (c.scope = 'org' or (s.visibility = 'private' and c.owner_id = s.owner_id and s.access_owner_id = s.owner_id)))
 then raise exception 'Connection cannot be bound to this sandbox'; end if;
 return new;
end $$;
revoke all on function public.check_mcp_binding() from public,anon,authenticated;
create trigger check_mcp_binding before insert or update on public.mcp_bindings for each row execute function public.check_mcp_binding();

create function public.fence_sandbox_mcp() returns trigger language plpgsql set search_path=public as $$
begin
 if new.status in ('stopped','deleted','failed') and new.status is distinct from old.status then
  new.mcp_generation := old.mcp_generation + 1;
 end if;
 return new;
end $$;
revoke all on function public.fence_sandbox_mcp() from public,anon,authenticated;
create trigger fence_sandbox_mcp before update on public.sandboxes for each row execute function public.fence_sandbox_mcp();

-- Claim is consumed durably before any upstream exchange. Expiry never permits token replay.
alter table public.mcp_grants add column refresh_consumed boolean not null default false;
create table public.mcp_pending_oauth (
 hash text primary key check(hash ~ '^[a-f0-9]{64}$'),
 actor_id uuid not null references auth.users(id),
 connection_id uuid not null references public.mcp_connections(id) on delete cascade,
 org_id uuid not null references public.orgs(id) on delete cascade,
 generation integer not null, expires_at timestamptz not null, payload_enc bytea not null
);
-- Poll independently per replica with a durable cursor; NOT a competing-consumer queue.
create table public.mcp_invalidations (
 id bigint generated always as identity primary key,
 connection_id uuid, sandbox_id uuid, org_id uuid not null,
 generation integer, reason text not null check(reason in ('grant','definition','membership','sandbox')),
 created_at timestamptz not null default now()
);
alter table public.mcp_pending_oauth enable row level security;
alter table public.mcp_invalidations enable row level security;
revoke all on public.mcp_pending_oauth,public.mcp_invalidations from anon,authenticated;
revoke all on sequence public.mcp_invalidations_id_seq from anon,authenticated;
grant all on public.mcp_pending_oauth,public.mcp_invalidations to service_role;
grant usage,select on sequence public.mcp_invalidations_id_seq to service_role;

create function public.emit_mcp_invalidation() returns trigger language plpgsql security definer set search_path=public as $$
declare connection uuid; organization uuid;
begin
 if tg_table_name = 'mcp_grants' then
  if tg_op = 'UPDATE' and new.generation = old.generation and new.revoked_at is not distinct from old.revoked_at then return new; end if;
  connection := old.connection_id;
  select org_id into organization from public.mcp_connections where id=connection;
  if organization is not null then insert into public.mcp_invalidations(connection_id,org_id,generation,reason)
   values(connection,organization,old.generation,'grant'); end if;
 elsif tg_table_name = 'mcp_connections' then
  insert into public.mcp_invalidations(connection_id,org_id,reason) values(old.id,old.org_id,'definition');
 elsif tg_table_name = 'sandboxes' then
  if new.mcp_generation <> old.mcp_generation then
   insert into public.mcp_invalidations(sandbox_id,org_id,generation,reason) values(old.id,old.org_id,new.mcp_generation,'sandbox');
  end if;
 elsif tg_table_name = 'members' then
  if tg_op='UPDATE' and new.org_id=old.org_id and new.user_id=old.user_id and new.role=old.role then return null; end if;
  -- Permanent actor/org fences: restoring membership must never revive old capabilities.
  update public.mcp_leases set revoked_at=coalesce(revoked_at,now())
   where org_id=old.org_id and owner_id=old.user_id;
  update public.sandboxes set mcp_generation=mcp_generation+1
   where org_id=old.org_id and owner_id=old.user_id;
  delete from public.mcp_pending_oauth where org_id=old.org_id and actor_id=old.user_id;
  update public.mcp_grants g set generation=generation+1,version=version+1,
   revoked_at=now(),value_enc=null,status='not_connected',refresh_owner=null,refresh_until=null
   from public.mcp_connections c where g.connection_id=c.id and c.org_id=old.org_id
    and c.scope='personal' and c.owner_id=old.user_id;
  -- Shared upstream grants and other actors' leases remain intact.
  insert into public.mcp_invalidations(sandbox_id,org_id,reason)
   select id,org_id,'membership' from public.sandboxes where org_id=old.org_id and owner_id=old.user_id;
 end if;
 return null;
end $$;
revoke all on function public.emit_mcp_invalidation() from public,anon,authenticated;
create trigger mcp_grant_invalidation after update or delete on public.mcp_grants for each row execute function public.emit_mcp_invalidation();
create trigger mcp_definition_invalidation after update or delete on public.mcp_connections for each row execute function public.emit_mcp_invalidation();
create trigger mcp_sandbox_invalidation after update on public.sandboxes for each row execute function public.emit_mcp_invalidation();
create trigger mcp_member_invalidation after delete or update on public.members for each row execute function public.emit_mcp_invalidation();

-- Individual durable acknowledgements avoid skipping a late-committing lower event id.
create table public.mcp_invalidation_deliveries (
 replica_id uuid not null, event_id bigint not null references public.mcp_invalidations(id) on delete cascade,
 primary key(replica_id,event_id)
);
alter table public.mcp_invalidation_deliveries enable row level security;
revoke all on public.mcp_invalidation_deliveries from anon,authenticated;
grant all on public.mcp_invalidation_deliveries to service_role;

create function public.guard_sandbox_source_visibility() returns trigger language plpgsql set search_path=public as $$
begin
 if new.source_golden_visibility is distinct from old.source_golden_visibility then
  raise exception 'A sandbox provider credential source is immutable';
 end if;
 return new;
end $$;
revoke all on function public.guard_sandbox_source_visibility() from public,anon,authenticated;
create trigger guard_sandbox_source_visibility before update on public.sandboxes
 for each row execute function public.guard_sandbox_source_visibility();
