-- Delegated access belongs to a sandbox, not to the optional orchestrator UI.
-- Service-owned only: callers can never mint or mutate an epoch using a user JWT.
create table public.armada_access_parents (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('orchestrator','sandbox')),
 org_id uuid not null references public.orgs(id),
 owner_id uuid not null references auth.users(id),
 sandbox_id uuid unique references public.sandboxes(id),
 state text not null check(state in ('creating','ready','stopping','stopped','resuming','blocked')),
 authority_epoch bigint not null default 1 check(authority_epoch > 0),
 generation bigint not null default 1 check(generation > 0),
 golden_ids uuid[] not null default '{}',
 credential_ids uuid[] not null default '{}',
 unique(id,org_id,owner_id)
);
alter table public.armada_access_parents enable row level security;
revoke all on public.armada_access_parents from public,anon,authenticated;
grant all on public.armada_access_parents to service_role;

insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,authority_epoch)
 select id,'orchestrator',org_id,owner_id,sandbox_id,state,authority_epoch from public.orchestrators;

-- Preserve the existing orchestrator runtime while moving the shared authority boundary.
create function public.sync_orchestrator_access_parent() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='DELETE' then
  delete from public.armada_access_parents where id=old.id and kind='orchestrator';
  return old;
 end if;
 insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,authority_epoch)
 values(new.id,'orchestrator',new.org_id,new.owner_id,new.sandbox_id,new.state,new.authority_epoch)
 on conflict(id) do update set sandbox_id=excluded.sandbox_id,state=excluded.state,authority_epoch=excluded.authority_epoch
 where (armada_access_parents.sandbox_id,armada_access_parents.state,armada_access_parents.authority_epoch)
 is distinct from (excluded.sandbox_id,excluded.state,excluded.authority_epoch);
 return new;
end $$;
create trigger orchestrator_access_parent after insert or update or delete on public.orchestrators
 for each row execute function public.sync_orchestrator_access_parent();
create function public.sync_access_parent_epoch() returns trigger language plpgsql set search_path=public as $$
begin
 if new.kind='orchestrator' then
  update public.orchestrators set authority_epoch=new.authority_epoch where id=new.id and authority_epoch is distinct from new.authority_epoch;
 end if;
 return new;
end $$;
create trigger access_parent_epoch after update of authority_epoch on public.armada_access_parents
 for each row execute function public.sync_access_parent_epoch();

-- Keep the established receipts and scoped gateway, but permit either parent kind.
do $$
declare constraint_row record;
begin
 for constraint_row in select c.conrelid::regclass as relation,c.conname from pg_constraint c
  where c.contype='f' and c.confrelid='public.orchestrators'::regclass and c.conrelid in
   ('public.orchestrator_delegations'::regclass,'public.orchestrator_children'::regclass,
    'public.orchestrator_child_operations'::regclass,'public.orchestrator_lifecycle'::regclass)
 loop execute format('alter table %s drop constraint %I',constraint_row.relation,constraint_row.conname); end loop;
end $$;
alter table public.orchestrator_delegations add foreign key(orchestrator_id) references public.armada_access_parents(id);
alter table public.orchestrator_children add foreign key(orchestrator_id,org_id,owner_id) references public.armada_access_parents(id,org_id,owner_id);
alter table public.orchestrator_child_operations add foreign key(orchestrator_id,org_id,owner_id) references public.armada_access_parents(id,org_id,owner_id);
alter table public.orchestrator_lifecycle add foreign key(orchestrator_id) references public.armada_access_parents(id);

create function public.guard_armada_access_parent() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' and (new.id,new.kind,new.org_id,new.owner_id) is distinct from (old.id,old.kind,old.org_id,old.owner_id) then
  raise exception 'immutable delegated parent identity' using errcode='23514';
 end if;
 if new.sandbox_id is not null then
  perform 1 from public.sandboxes s where s.id=new.sandbox_id and s.org_id=new.org_id and s.owner_id=new.owner_id
   and s.access_owner_id=new.owner_id and s.visibility='private' for update;
  if not found or exists(select 1 from public.orchestrator_children where sandbox_id=new.sandbox_id) then
   raise exception 'delegated parent must be owner private and not a child' using errcode='23514';
  end if;
 end if;
 if tg_op='UPDATE' and old.sandbox_id is not null and new.sandbox_id is distinct from old.sandbox_id then
  raise exception 'immutable delegated parent sandbox' using errcode='23514';
 end if;
 return new;
end $$;
create trigger armada_access_parent_identity before insert or update on public.armada_access_parents
 for each row execute function public.guard_armada_access_parent();

create or replace function public.guard_orchestrator_child() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' then raise exception 'immutable child relation' using errcode='23514'; end if;
 perform 1 from public.sandboxes s where s.id=new.sandbox_id and s.org_id=new.org_id and s.owner_id=new.owner_id for update;
 if not found or exists(select 1 from public.armada_access_parents where sandbox_id=new.sandbox_id) then
  raise exception 'invalid child ownership' using errcode='23514';
 end if;
 return new;
end $$;

-- Revocation remains monotonic across membership removal and native replacement.
create or replace function public.revoke_removed_orchestrator_member() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.armada_access_parents set authority_epoch=authority_epoch+1 where org_id=old.org_id and owner_id=old.user_id;
 return old;
end $$;
create or replace function public.revoke_rebound_orchestrator_native() returns trigger language plpgsql set search_path=public as $$
begin
 if new.orchestrator_native_generation is distinct from old.orchestrator_native_generation then
  update public.armada_access_parents set authority_epoch=authority_epoch+1,generation=generation+1 where sandbox_id=new.id;
 end if;
 return new;
end $$;

revoke all on function public.sync_orchestrator_access_parent(),public.sync_access_parent_epoch(),public.guard_armada_access_parent() from public,anon,authenticated;

-- Ordinary lifecycle updates revoke before a stopped/deleted/rebound parent can act.
create function public.fence_sandbox_armada_access() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.armada_access_parents where sandbox_id=old.id) and
  (new.org_id,new.owner_id,new.access_owner_id,new.visibility,new.golden_id) is distinct from
  (old.org_id,old.owner_id,old.access_owner_id,old.visibility,old.golden_id) then
  raise exception 'immutable delegated parent access' using errcode='23514';
 end if;
 if (new.status,new.stop_requested_at) is distinct from (old.status,old.stop_requested_at) then
  update public.armada_access_parents set
   state=case when new.status in ('stopped','deleted','failed') then 'stopped'
    when new.stop_requested_at is not null then 'stopping' else 'ready' end,
   authority_epoch=authority_epoch+case when new.status in ('stopped','deleted','failed') or new.stop_requested_at is not null
    then 1 else 0 end,
   generation=generation+case when new.status in ('stopped','deleted','failed') or new.stop_requested_at is not null then 1 else 0 end
   where sandbox_id=new.id and kind='sandbox';
 end if;
 return new;
end $$;
create trigger sandbox_armada_access_fence before update on public.sandboxes
 for each row execute function public.fence_sandbox_armada_access();
revoke all on function public.fence_sandbox_armada_access() from public,anon,authenticated;

create function public.owns_armada_access_parent(target uuid) returns boolean language sql stable security definer
 set search_path=public as $$
 select exists(select 1 from public.armada_access_parents p join public.members m on m.org_id=p.org_id and m.user_id=p.owner_id
  where p.id=target and p.owner_id=auth.uid())
$$;
revoke all on function public.owns_armada_access_parent(uuid) from public,anon;
grant execute on function public.owns_armada_access_parent(uuid) to authenticated,service_role;
drop policy children_owner on public.orchestrator_children;
create policy children_owner on public.orchestrator_children for select to authenticated using(public.owns_armada_access_parent(orchestrator_id));
drop policy child_operations_owner on public.orchestrator_child_operations;
create policy child_operations_owner on public.orchestrator_child_operations for select to authenticated using(public.owns_armada_access_parent(orchestrator_id));
drop policy lifecycle_owner on public.orchestrator_lifecycle;
create policy lifecycle_owner on public.orchestrator_lifecycle for select to authenticated using(public.owns_armada_access_parent(orchestrator_id));
