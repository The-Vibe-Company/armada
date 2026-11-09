-- Foundation only: no API grant issuance or compute allocation is enabled.
create table public.orchestrators (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 owner_id uuid not null references auth.users(id),
 sandbox_id uuid unique references public.sandboxes(id),
 state text not null default 'creating' check(state in ('creating','ready','stopping','stopped','resuming','blocked')),
 revision bigint not null default 0 check(revision >= 0),
 authority_epoch bigint not null default 1 check(authority_epoch > 0),
 created_at timestamptz not null default now(),
 unique(id,org_id,owner_id)
);
create table public.orchestrator_children (
 sandbox_id uuid primary key references public.sandboxes(id),
 orchestrator_id uuid not null,
 org_id uuid not null,
 owner_id uuid not null,
 foreign key(orchestrator_id,org_id,owner_id) references public.orchestrators(id,org_id,owner_id)
);
create table public.orchestrator_operations (
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.orchestrators(id),
 actor_id uuid not null references auth.users(id),
 action text not null check(action in ('create','message','steer','stop','resume')),
 idempotency_key text not null check(length(idempotency_key) between 1 and 128 and idempotency_key !~ '[^ -~]'),
 request_digest text not null check(request_digest ~ '^[0-9a-f]{64}$'),
 revision bigint not null,
 state text not null default 'pending' check(state in ('pending','succeeded','failed','uncertain')),
 error_code text,
 unique(orchestrator_id,actor_id,action,idempotency_key)
);
create table public.orchestrator_delegations (
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.orchestrators(id),
 hash text not null unique check(hash ~ '^[0-9a-f]{64}$'),
 epoch bigint not null,
 physical_generation bigint not null,
 scopes text[] not null check(scopes <@ array['worker:launch','worker:read','worker:message','worker:stop']::text[]),
 golden_ids uuid[] not null,
 account_ids uuid[] not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 acknowledged_at timestamptz,
 revoked_at timestamptz,
 check(expires_at > created_at and expires_at <= created_at + interval '24 hours')
);

-- Relations cannot be reassigned, even by a stale privileged service operation.
create function public.guard_orchestrator_identity() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' and (new.id,new.org_id,new.owner_id) is distinct from (old.id,old.org_id,old.owner_id) then
  raise exception 'immutable orchestrator identity' using errcode='23514';
 end if;
 if new.sandbox_id is not null then
  perform 1 from public.sandboxes s where s.id=new.sandbox_id and s.org_id=new.org_id
   and s.owner_id=new.owner_id and s.access_owner_id=new.owner_id and s.visibility='private' for update;
  if not found or exists(select 1 from public.orchestrator_children where sandbox_id=new.sandbox_id) then raise exception 'parent must be owner private and not a child' using errcode='23514'; end if;
 end if;
 if tg_op='UPDATE' and old.sandbox_id is not null and new.sandbox_id is distinct from old.sandbox_id then
  raise exception 'immutable managed parent' using errcode='23514';
 end if;
 if tg_op='UPDATE' and new.state is distinct from old.state and new.state<>'ready' then
  new.authority_epoch := old.authority_epoch+1;
 end if;
 return new;
end $$;
create trigger orchestrator_identity before insert or update on public.orchestrators
 for each row execute function public.guard_orchestrator_identity();
create function public.guard_orchestrator_sandbox() returns trigger language plpgsql set search_path=public as $$
begin
 if exists(select 1 from public.orchestrators o where o.sandbox_id=old.id)
 and (new.org_id,new.owner_id,new.access_owner_id,new.visibility,new.golden_id)
 is distinct from (old.org_id,old.owner_id,old.access_owner_id,old.visibility,old.golden_id) then
  raise exception 'immutable managed parent access' using errcode='23514';
 end if;
 if exists(select 1 from public.orchestrator_children c where c.sandbox_id=old.id)
 and (new.org_id,new.owner_id) is distinct from (old.org_id,old.owner_id) then
  raise exception 'immutable child ownership' using errcode='23514';
 end if;
 return new;
end $$;
create trigger orchestrator_sandbox_identity before update on public.sandboxes
 for each row execute function public.guard_orchestrator_sandbox();
create function public.guard_orchestrator_child() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' then raise exception 'immutable child relation' using errcode='23514'; end if;
 perform 1 from public.sandboxes s where s.id=new.sandbox_id and s.org_id=new.org_id and s.owner_id=new.owner_id for update;
 if not found or exists(select 1 from public.orchestrators where sandbox_id=new.sandbox_id) then
  raise exception 'invalid child ownership' using errcode='23514';
 end if;
 return new;
end $$;
create trigger orchestrator_child_identity before insert or update on public.orchestrator_children
 for each row execute function public.guard_orchestrator_child();

alter table public.orchestrators enable row level security;
alter table public.orchestrator_children enable row level security;
alter table public.orchestrator_operations enable row level security;
alter table public.orchestrator_delegations enable row level security;
revoke all on public.orchestrators,public.orchestrator_children,public.orchestrator_operations,public.orchestrator_delegations from public,anon,authenticated;
grant all on public.orchestrators,public.orchestrator_children,public.orchestrator_operations,public.orchestrator_delegations to service_role;
grant select on public.orchestrators,public.orchestrator_children,public.orchestrator_operations to authenticated;
create policy orchestrators_owner on public.orchestrators for select to authenticated using (
 owner_id=auth.uid() and exists(select 1 from public.members m where m.org_id=orchestrators.org_id and m.user_id=auth.uid()));
create policy children_owner on public.orchestrator_children for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));
create policy operations_owner on public.orchestrator_operations for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));
-- A security-definer boolean avoids leaking private parent metadata while fencing all JWT routes.
create function public.is_orchestrator_parent(target uuid) returns boolean language sql stable security definer
 set search_path=public as $$ select exists(select 1 from public.orchestrators where sandbox_id=target) $$;
revoke all on function public.is_orchestrator_parent(uuid) from public,anon;
grant execute on function public.is_orchestrator_parent(uuid) to authenticated,service_role;
create policy managed_parent_fence on public.sandboxes as restrictive for all to authenticated
 using (not public.is_orchestrator_parent(id)) with check(not public.is_orchestrator_parent(id));
revoke all on function public.guard_orchestrator_identity(),public.guard_orchestrator_sandbox(),public.guard_orchestrator_child() from public,anon,authenticated;

create function public.revoke_removed_orchestrator_member() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.orchestrators set authority_epoch=authority_epoch+1 where org_id=old.org_id and owner_id=old.user_id;
 return old;
end $$;
create trigger orchestrator_member_removal before delete on public.members for each row
 execute function public.revoke_removed_orchestrator_member();
revoke all on function public.revoke_removed_orchestrator_member() from public,anon,authenticated;
