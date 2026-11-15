-- Server-only durable, encrypted model-account prompt queue.
create table public.account_turn_queue (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  request_id uuid not null,
  account_id uuid not null references public.credentials(id),
  owner_id uuid not null,
  org_id uuid not null references public.orgs(id),
  actor_epoch bigint not null,
  credential_version integer not null,
  input_hash text not null,
  input_enc bytea not null,
  conversation_id text not null,
  sequence bigint generated always as identity unique,
  state text not null default 'queued' check (state in ('queued','dispatching','admitted','failed')),
  dispatch_generation bigint,
  dispatch_until timestamptz,
  result_enc bytea,
  failure_reason text,
  primary key (sandbox_id,request_id)
);
alter table public.account_turn_queue enable row level security;
revoke all on public.account_turn_queue from anon, authenticated;
grant all on public.account_turn_queue to service_role;
create index account_turn_queue_waiting on public.account_turn_queue(account_id,sequence) where state='queued';

-- Allocation ownership transfers only when a turn identity is published, or
-- readiness proves there is no pending prompt. In particular Docker's running
-- status may precede the native prompt receipt and must retain its reservation.
create or replace function public.release_account_agent_reservation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- Readiness/status observations may repeat the prior settled task while a
  -- newly claimed send has not yet acquired its activity fence. They cannot
  -- transfer that new reservation back to historical turn evidence.
  if exists(select 1 from public.account_turn_queue q where q.sandbox_id=new.id
      and q.state='dispatching'
      and not (new.status in ('stopped','deleted') and new.lifecycle_generation>q.dispatch_generation))
     and (tg_op='INSERT' or new.task_prompt_id is not distinct from old.task_prompt_id) then
    return new;
  end if;
  if new.deleted_at is not null or new.stopped_at is not null
     or new.task_prompt_id is not null
     or (new.status='ready' and not exists (
       select 1 from public.runtime_commands c where c.sandbox_id=new.id
         and c.result_enc is null and
           (starts_with(c.request_id,'docker_prompt_') or starts_with(c.request_id,'follow_'))
     )) then
    delete from public.account_agent_reservations where sandbox_id=new.id;
  end if;
  return new;
end;
$$;
drop trigger release_account_agent_reservation on public.sandboxes;
create trigger release_account_agent_reservation
  after insert or update of status, stopped_at, deleted_at, task_prompt_id on public.sandboxes
  for each row execute function public.release_account_agent_reservation();
