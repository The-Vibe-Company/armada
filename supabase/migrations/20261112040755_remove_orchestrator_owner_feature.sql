-- DRAFT #984 step 5: destructive owner-feature retirement; NOT AUTHORIZED TO APPLY.
-- Version 20261112040755 checked against main/local history and 30 open PRs.
-- DO NOT APPLY until the coordinator relays the owner's step-5 go, step 4 is
-- deployed/drained everywhere, the replacement's staging proof is accepted,
-- the replacement iPhone build is published, and cleanup/provider evidence is
-- retained for EVERY owner, organization, parent and child.
-- A SQL closed-state guard is not independent proof of released cloud compute.
-- Destructive: erases legacy owner identities/configuration/history/receipts and
-- their shared delegation/child/cap metadata; retains sandboxes and archives.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- Freeze the old feature and the generic shared boundary for one short atomic
-- change. This may briefly block ordinary launches; drain before applying.
lock table public.orchestrators,
 public.orchestrator_operations,
 public.orchestrator_runtime,
 public.orchestrator_runtime_create_keys,
 public.orchestrator_runtime_events,
 public.orchestrator_waits,
 public.orchestrator_lifecycle_mutations,
 public.orchestrator_activity,
 public.armada_access_parents,
 public.orchestrator_delegations,
 public.orchestrator_children,
 public.orchestrator_child_operations,
 public.orchestrator_lifecycle,
 public.sandboxes
 in access exclusive mode;

-- Refuse partial/corrupt cleanup or a still-live owner runtime. Do not make a
-- migration 'succeed' by setting lifecycle fields or manufacturing receipts.
do $$
begin
 if exists (
  select 1 from public.orchestrators o
  left join public.armada_access_parents p on p.id=o.id
  where p.id is null or p.kind<>'orchestrator'
   or (p.org_id,p.owner_id,p.sandbox_id) is distinct from
      (o.org_id,o.owner_id,o.sandbox_id)
 ) or exists (
  select 1 from public.armada_access_parents p
  where p.kind='orchestrator'
   and not exists(select 1 from public.orchestrators o where o.id=p.id)
 ) then
  raise exception 'orchestrator retirement refused: parent identity inventory is inconsistent' using errcode='23514';
 end if;
 if exists (
  select 1 from public.orchestrators o
  join public.armada_access_parents p on p.id=o.id
  where o.state<>'stopped' or p.state<>'stopped'
 ) then
  raise exception 'orchestrator retirement refused: every legacy parent must be stopped' using errcode='23514';
 end if;
 if exists (
  select 1 from public.orchestrators o
  join public.sandboxes s on s.id=o.sandbox_id
  where s.status not in ('stopped','deleted','failed') or s.stopped_at is null
 ) then
  raise exception 'orchestrator retirement refused: parent compute closure is unconfirmed' using errcode='23514';
 end if;
 if exists (
  select 1 from public.orchestrator_children c
  join public.armada_access_parents p on p.id=c.orchestrator_id
  join public.sandboxes s on s.id=c.sandbox_id
  where p.kind='orchestrator'
   and (s.status not in ('stopped','deleted','failed') or s.stopped_at is null)
 ) then
  raise exception 'orchestrator retirement refused: legacy child compute closure is unconfirmed' using errcode='23514';
 end if;
 if exists (select 1 from public.orchestrator_operations where state in ('pending','uncertain'))
 or exists (
  select 1 from public.orchestrator_child_operations op
  join public.armada_access_parents p on p.id=op.orchestrator_id
  where p.kind='orchestrator' and op.state in ('pending','uncertain')
 ) then
  raise exception 'orchestrator retirement refused: unresolved owner or child operations remain' using errcode='23514';
 end if;
 if exists (
  select 1 from public.orchestrator_lifecycle l
  join public.armada_access_parents p on p.id=l.orchestrator_id
  where p.kind='orchestrator' and l.lease is not null and l.lease_until>clock_timestamp()
 ) or exists (
  select 1 from public.orchestrator_waits w
  where w.released_at is null and w.expires_at>clock_timestamp()
 ) then
  raise exception 'orchestrator retirement refused: worker or wait leases remain live' using errcode='23514';
 end if;
 if exists (
  select 1 from public.orchestrator_delegations d
  join public.armada_access_parents p on p.id=d.orchestrator_id
  where p.kind='orchestrator' and d.epoch=p.authority_epoch
   and d.revoked_at is null and d.expires_at>clock_timestamp()
 ) then
  raise exception 'orchestrator retirement refused: current legacy authority has not been revoked' using errcode='23514';
 end if;
end $$;

-- Snapshot the retired identity set, not sandbox ids or labels. Every shared-row
-- deletion below is fenced to this exact legacy kind, never all shared rows.
create temporary table retired_orchestrator_ids(id uuid primary key) on commit drop;
insert into retired_orchestrator_ids(id)
 select id from public.armada_access_parents where kind='orchestrator';

-- Remove bidirectional compatibility synchronization before identity deletion.
-- Otherwise deleting the old row can delete generic parents during table DDL.
drop trigger orchestrator_access_parent on public.orchestrators;
drop trigger access_parent_epoch on public.armada_access_parents;
drop function public.sync_orchestrator_access_parent();
drop function public.sync_access_parent_epoch();

-- The four established generic stores are required by ordinary --armada-access.
-- Delete only retired owner-feature rows, retaining every kind='sandbox' row.
delete from public.orchestrator_delegations
 where orchestrator_id in (select id from retired_orchestrator_ids);
delete from public.orchestrator_child_operations
 where orchestrator_id in (select id from retired_orchestrator_ids);
delete from public.orchestrator_children
 where orchestrator_id in (select id from retired_orchestrator_ids);
delete from public.orchestrator_lifecycle
 where orchestrator_id in (select id from retired_orchestrator_ids);
delete from public.armada_access_parents
 where kind='orchestrator' and id in (select id from retired_orchestrator_ids);

-- Keep the existing trigger and ACL but make its parent check generic. The
-- newer sandbox_armada_access_fence already covers generic parent's golden
-- binding; retaining this check also preserves the original child-ownership
-- protection independently of which client/privileged path writes sandboxes.
create or replace function public.guard_orchestrator_sandbox() returns trigger
language plpgsql set search_path=public as $$
begin
 if exists(select 1 from public.armada_access_parents p where p.sandbox_id=old.id)
 and (new.org_id,new.owner_id,new.access_owner_id,new.visibility,new.golden_id)
 is distinct from (old.org_id,old.owner_id,old.access_owner_id,old.visibility,old.golden_id) then
  raise exception 'immutable delegated parent access' using errcode='23514';
 end if;
 if exists(select 1 from public.orchestrator_children c where c.sandbox_id=old.id)
 and (new.org_id,new.owner_id) is distinct from (old.org_id,old.owner_id) then
  raise exception 'immutable child ownership' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function public.guard_orchestrator_sandbox() from public,anon,authenticated;

-- Preserve the latest work-preservation projection, membership rule, interior
-- column authorization and exact result type. Retired parent sandbox rows remain
-- ordinary stopped sandbox history; no legacy identity exclusion remains.
create or replace function public.sandbox_list_metadata()
returns table (
 "providerSandboxId" text, "boatId" text, id uuid, "orgId" uuid, "ownerId" uuid, provider text, harness text, model text,
 "reasoningEffort" text, status text, "createdAt" timestamptz, "stoppedAt" timestamptz,
 "expiresAt" timestamptz, "effectiveTtlSeconds" integer, "machineSize" text,
 "taskOutcome" jsonb, "preservationNote" text, "displayLabel" text, "canOpen" boolean, "canManage" boolean
) language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(s.provider_sandbox_id,''),case when s.provider='boat' then nullif(s.provider_sandbox_id,'') else null end,
 s.id,s.org_id,s.owner_id,s.provider::text,s.harness::text,s.model,s.reasoning_effort,
 s.status::text,s.created_at,s.stopped_at,s.expires_at,s.effective_ttl_seconds,
 case when s.machine_size->>'effective' in ('small','medium','large','xlarge') then s.machine_size->>'effective' else null end,
 case when public.can_open_sandbox(s.org_id,s.owner_id) then s.task_outcome else null end,
 s.preservation_note, 'Sandbox ' || s.id::text,public.can_open_sandbox(s.org_id,s.owner_id),public.can_open_sandbox(s.org_id,s.owner_id)
 from public.sandboxes s
 where exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=auth.uid())
 order by s.created_at desc,s.id
$$;
revoke all on function public.sandbox_list_metadata() from public,anon;
grant execute on function public.sandbox_list_metadata() to authenticated,service_role;

-- Remove the old hidden-parent policy only after all parents have positive
-- stopped-state evidence and generic authority relations have been removed.
drop policy managed_parent_fence on public.sandboxes;
drop function public.is_orchestrator_parent(uuid);

-- Deliberately no CASCADE or IF EXISTS. An unexpected dependency or mismatched
-- deployment must abort rather than erase a replacement access path silently.
drop table public.orchestrator_runtime_events;
drop table public.orchestrator_runtime_create_keys;
drop table public.orchestrator_runtime;
drop table public.orchestrator_waits;
drop table public.orchestrator_lifecycle_mutations;
drop table public.orchestrator_activity;
drop table public.orchestrator_operations;
drop table public.orchestrators;
drop function public.guard_orchestrator_identity();

-- KEEP: armada_access_parents; orchestrator_delegations/children/
-- child_operations/lifecycle; sandboxes.orchestrator_native_generation;
-- guard_armada_access_parent, guard_orchestrator_child,
-- guard_orchestrator_child_operation, revoke_removed_orchestrator_member,
-- revoke_rebound_orchestrator_native, fence_sandbox_armada_access,
-- owns_armada_access_parent and their ownership/revocation/RLS triggers.
commit;
