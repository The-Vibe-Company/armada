-- Requires the separately reviewed authority foundation (208). No feature enablement.
create table public.orchestrator_lifecycle (
 orchestrator_id uuid primary key references public.orchestrators(id),
 idle_seconds integer not null default 7200 check(idle_seconds between 900 and 86400),
 -- NULL means no owner-configured concurrency policy; never a provider quota.
 max_active_children integer check(max_active_children > 0),
 last_activity_at timestamptz not null default now(),
 observation_state text not null default 'unknown' check(observation_state in ('unknown','active','quiescent')),
 observation_generation bigint,
 observation_evidence text,
 observed_at timestamptz,
 reconcile_after timestamptz not null default now(),
 lease uuid,
 lease_until timestamptz,
 stop_operation_id uuid,
 stop_generation bigint,
 stop_physical_generation text,
 stop_sandbox_id uuid,
 stop_provider_sandbox_id text,
 stop_reason text check(stop_reason in ('idle','hard_ttl','epoch_expiry','owner_removed')),
 stop_dispatched boolean not null default false,
 reason text not null default 'runtime_unobserved'
);
create table public.orchestrator_child_operations (
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.orchestrators(id),
 owner_id uuid not null references auth.users(id),
 org_id uuid not null references public.orgs(id),
 parent_generation bigint not null,
 parent_epoch bigint not null,
 action text not null check(action in ('launch','message','stop')),
 target_id uuid not null,
 scope_target uuid not null,
 idempotency_key text not null check(idempotency_key ~ '^[ -~]{1,128}$'),
 request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
 state text not null default 'pending' check(state in ('pending','succeeded','failed','uncertain')),
 dispatched_at timestamptz,
 reconcile_after timestamptz not null default now(),
 reconcile_lease uuid,
 reconcile_until timestamptz,
 provider_sandbox_id text,
 error_code text,
 created_at timestamptz not null default now(),
 unique(orchestrator_id,action,scope_target,idempotency_key),
 foreign key(orchestrator_id,org_id,owner_id) references public.orchestrators(id,org_id,owner_id)
);
create table public.orchestrator_waits (
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.orchestrators(id),
 parent_generation bigint not null,
 kind text not null check(kind in ('ci','child','external','task')),
 reference text not null check(length(reference) between 1 and 512),
 reason text not null check(length(reason) between 1 and 512),
 evidence text not null check(length(evidence) between 1 and 512),
 evidence_at timestamptz not null,
 expires_at timestamptz not null,
 deadline timestamptz not null,
 created_at timestamptz not null,
 released_at timestamptz,
 -- Retain exhausted references: a heartbeat/re-registration cannot reset the cap.
 unique(orchestrator_id,kind,reference),
 check(expires_at <= deadline),
 check(released_at is not null or expires_at > evidence_at),
 check(deadline <= created_at + interval '24 hours'),
 check(released_at is not null or expires_at <= evidence_at + interval '15 minutes')
);
create index orchestrator_lifecycle_due on public.orchestrator_lifecycle(reconcile_after);
create index orchestrator_child_pending on public.orchestrator_child_operations(orchestrator_id,state);
create index orchestrator_waits_active on public.orchestrator_waits(orchestrator_id,expires_at) where released_at is null;

alter table public.orchestrator_lifecycle enable row level security;
alter table public.orchestrator_child_operations enable row level security;
alter table public.orchestrator_waits enable row level security;
revoke all on public.orchestrator_lifecycle,public.orchestrator_child_operations,public.orchestrator_waits from public,anon,authenticated;
grant all on public.orchestrator_lifecycle,public.orchestrator_child_operations,public.orchestrator_waits to service_role;
grant select on public.orchestrator_lifecycle,public.orchestrator_child_operations,public.orchestrator_waits to authenticated;
create policy lifecycle_owner on public.orchestrator_lifecycle for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));
create policy child_operations_owner on public.orchestrator_child_operations for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));
create policy waits_owner on public.orchestrator_waits for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));

-- A privileged delayed worker cannot reassign a reservation or its recorded provider receipt.
create function public.guard_orchestrator_child_operation() returns trigger language plpgsql set search_path=public as $$
begin
 if (new.id,new.orchestrator_id,new.org_id,new.owner_id,new.parent_generation,new.parent_epoch,new.action,new.target_id,new.scope_target,new.idempotency_key,new.request_digest)
 is distinct from (old.id,old.orchestrator_id,old.org_id,old.owner_id,old.parent_generation,old.parent_epoch,old.action,old.target_id,old.scope_target,old.idempotency_key,old.request_digest)
 or (old.provider_sandbox_id is not null and new.provider_sandbox_id is distinct from old.provider_sandbox_id) then
  raise exception 'immutable child reservation' using errcode='23514';
 end if;
 return new;
end $$;
create trigger orchestrator_child_operation_identity before update on public.orchestrator_child_operations
 for each row execute function public.guard_orchestrator_child_operation();
revoke all on function public.guard_orchestrator_child_operation() from public,anon,authenticated;

create table public.orchestrator_lifecycle_mutations (
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.orchestrators(id),
 actor_id uuid not null references auth.users(id),
 action text not null,
 target text not null,
 idempotency_key text not null check(idempotency_key ~ '^[ -~]{1,128}$'),
 request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
 result jsonb not null,
 unique(orchestrator_id,actor_id,action,target,idempotency_key)
);
alter table public.orchestrator_lifecycle_mutations enable row level security;
revoke all on public.orchestrator_lifecycle_mutations from public,anon,authenticated;
grant all on public.orchestrator_lifecycle_mutations to service_role;
grant select on public.orchestrator_lifecycle_mutations to authenticated;
create policy wait_operations_owner on public.orchestrator_lifecycle_mutations for select to authenticated using (
 exists(select 1 from public.orchestrators o where o.id=orchestrator_id));

-- No transcript, tool arguments/results or grant material in activity receipts.
create table public.orchestrator_activity (
 orchestrator_id uuid not null references public.orchestrators(id),
 sandbox_id uuid not null references public.sandboxes(id),
 parent_generation bigint not null,
 event_id text not null,
 prompt_id text not null,
 conversation_id text not null,
 observed_at timestamptz not null,
 primary key(orchestrator_id,sandbox_id,parent_generation,event_id)
);
alter table public.orchestrator_activity enable row level security;
revoke all on public.orchestrator_activity from public,anon,authenticated;
grant all on public.orchestrator_activity to service_role;
