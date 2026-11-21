begin;

create or replace function public.guard_armada_access_parent()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='UPDATE' then
  if (new.id,new.kind,new.org_id,new.owner_id) is distinct from (old.id,old.kind,old.org_id,old.owner_id) then
   raise exception 'immutable delegated parent identity' using errcode='23514';
  end if;
  -- Epoch/state writes already hold the parent row. Taking the sandbox here
  -- would invert the sandbox -> parent order used by the lifecycle fence.
  -- The sandbox fence prevents identity changes after a binding is created.
  if new.sandbox_id is not distinct from old.sandbox_id then
   return new;
  end if;
  if old.sandbox_id is not null then
   raise exception 'immutable delegated parent sandbox' using errcode='23514';
  end if;
 end if;
 if new.sandbox_id is not null then
  perform 1 from public.sandboxes s where s.id=new.sandbox_id and s.org_id=new.org_id and s.owner_id=new.owner_id
   and s.access_owner_id=new.owner_id and s.visibility='private' for no key update;
  if not found or exists(select 1 from public.orchestrator_children where sandbox_id=new.sandbox_id) then
   raise exception 'delegated parent must be owner private and not a child' using errcode='23514';
  end if;
 end if;
 return new;
end $$;

-- Epoch mirroring to the legacy orchestrator fires its reverse sync trigger.
-- Skip the redundant upsert before its INSERT guard can lock the sandbox.
create or replace function public.sync_orchestrator_access_parent()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='DELETE' then
  delete from public.armada_access_parents where id=old.id and kind='orchestrator';
  return old;
 end if;
 if tg_op='UPDATE' and exists(
  select 1 from public.armada_access_parents p where p.id=new.id and p.kind='orchestrator'
  and (p.sandbox_id,p.state,p.authority_epoch) is not distinct from (new.sandbox_id,new.state,new.authority_epoch)
 ) then
  return new;
 end if;
 insert into public.armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state,authority_epoch)
 values(new.id,'orchestrator',new.org_id,new.owner_id,new.sandbox_id,new.state,new.authority_epoch)
 on conflict(id) do update set sandbox_id=excluded.sandbox_id,state=excluded.state,authority_epoch=excluded.authority_epoch
 where (armada_access_parents.sandbox_id,armada_access_parents.state,armada_access_parents.authority_epoch)
 is distinct from (excluded.sandbox_id,excluded.state,excluded.authority_epoch);
 return new;
end $$;

commit;
