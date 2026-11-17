-- Durable organization webhook destinations and transactional delivery outbox.
-- The retired per-sandbox notify_subscriptions table has no delivery worker.
create table public.outbound_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  url text not null check (url ~ '^https://'),
  secret_enc bytea not null check (octet_length(secret_enc)>0),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index outbound_webhook_endpoints_org on public.outbound_webhook_endpoints(org_id);
create table public.outbound_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.outbound_webhook_endpoints(id) on delete cascade,
  payload jsonb not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_status integer,
  created_at timestamptz not null default now()
);
create index outbound_webhook_deliveries_due on public.outbound_webhook_deliveries(next_attempt_at)
  where delivered_at is null and attempts<5;
alter table public.outbound_webhook_endpoints enable row level security;
alter table public.outbound_webhook_deliveries enable row level security;
revoke all on public.outbound_webhook_endpoints,public.outbound_webhook_deliveries from public,anon,authenticated;
grant all on public.outbound_webhook_endpoints,public.outbound_webhook_deliveries to service_role;

-- A repeated terminal prompt observation must not create a second delivery.
create unique index outbound_webhook_turn_identity on public.outbound_webhook_deliveries
  (endpoint_id,(payload->>'sandboxId'),(payload->>'promptId'),(payload->>'type'))
  where payload->>'type' in ('turn.finished','turn.failed');

-- Runtime ingestion calls this inside its archive transaction. Native state
-- terminal observations use the same admission boundary.
create function public.enqueue_webhook_turn(sandbox uuid,prompt text,status text) returns void
language plpgsql security definer set search_path='' as $$
declare
  saved public.sandboxes%rowtype;
  endpoint record;
  delivery_id uuid;
  event_type text;
begin
  if prompt is null or status not in ('finished','failed','interrupted') then return; end if;
  select * into saved from public.sandboxes where id=sandbox;
  if not found then return; end if;
  event_type := case when status='finished' then 'turn.finished' else 'turn.failed' end;
  for endpoint in select id from public.outbound_webhook_endpoints
    where org_id=saved.org_id and enabled loop
    delivery_id := gen_random_uuid();
    insert into public.outbound_webhook_deliveries(id,endpoint_id,payload)
    values(delivery_id,endpoint.id,jsonb_build_object(
      'id',delivery_id,'type',event_type,'occurredAt',clock_timestamp(),
      'orgId',saved.org_id,'sandboxId',saved.id,'promptId',coalesce((
        select q.request_id::text from public.account_turn_queue q
        where q.sandbox_id=saved.id and (q.native_prompt_id=prompt or q.request_id::text=prompt)
        order by q.sequence desc limit 1),prompt),
      'state',status,'externalRef',to_jsonb(saved)->'external_ref',
      'reason',case when status='interrupted' then 'interrupted'
        when status='failed' then 'turn_failed' else null end))
    on conflict do nothing;
  end loop;
end;
$$;
revoke all on function public.enqueue_webhook_turn(uuid,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_webhook_turn(uuid,text,text) to service_role;

-- Capture public lifecycle facts atomically with the state change. Neither
-- provider diagnostics nor task report text is suitable for default payloads.
create function public.enqueue_sandbox_webhooks() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  event_type text;
  event_types text[] := '{}';
  endpoint record;
  delivery_id uuid;
  public_reason text;
begin
  if new.status is distinct from old.status then
    if new.status='stopped' then
      event_types := array_append(event_types,case when new.status_reason='expired'
        then 'sandbox.expired' else 'sandbox.stopped' end);
    elsif new.status='deleted' then
      event_types := array_append(event_types,'sandbox.reclaimed');
    end if;
  end if;
  if new.task_outcome is not null and (new.task_outcome is distinct from old.task_outcome
    or new.task_prompt_id is distinct from old.task_prompt_id) then
    event_types := array_append(event_types,'agent.report.'||(new.task_outcome->>'state'));
  end if;
  foreach event_type in array event_types loop
    public_reason := case
      when event_type='sandbox.expired' then 'expired'
      when event_type='sandbox.reclaimed' then case when new.status_reason in ('retention_elapsed','disk_pressure')
        then new.status_reason else 'reclaimed' end
      when event_type='agent.report.blocked' then 'agent_blocked'
      else null end;
    for endpoint in select id from public.outbound_webhook_endpoints
      where org_id=new.org_id and enabled loop
      delivery_id := gen_random_uuid();
      insert into public.outbound_webhook_deliveries(id,endpoint_id,payload)
      values(delivery_id,endpoint.id,jsonb_build_object(
        'id',delivery_id,'type',event_type,'occurredAt',clock_timestamp(),
        'orgId',new.org_id,'sandboxId',new.id,'promptId',coalesce((
          select q.request_id::text from public.account_turn_queue q
          where q.sandbox_id=new.id and (q.native_prompt_id=new.task_prompt_id or q.request_id::text=new.task_prompt_id)
          order by q.sequence desc limit 1),new.task_prompt_id),
        'state',new.status,'externalRef',to_jsonb(new)->'external_ref','reason',public_reason));
    end loop;
  end loop;
  return new;
end;
$$;
revoke all on function public.enqueue_sandbox_webhooks() from public,anon,authenticated;
create trigger sandbox_outbound_webhooks after update of status,task_outcome,task_prompt_id on public.sandboxes
  for each row execute function public.enqueue_sandbox_webhooks();

-- Native receipts outlive the mutable current task and machine lifecycle. Keep
-- only identities/observation metadata; provider transcript bytes never persist.
create table public.native_webhook_prompts (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  provider public.sandbox_provider not null,
  provider_sandbox_id text not null,
  owner_id uuid not null,
  org_id uuid not null,
  failures integer not null default 0 check (failures between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(sandbox_id,prompt_id)
);
create index native_webhook_prompts_due on public.native_webhook_prompts(next_attempt_at)
  where completed_at is null and failures<5;
alter table public.native_webhook_prompts enable row level security;
revoke all on public.native_webhook_prompts from public,anon,authenticated;
grant all on public.native_webhook_prompts to service_role;
-- Capture the public queue identity in the provider-publication transaction,
-- before a fast terminal receipt can precede encrypted send-result persistence.
alter table public.account_turn_queue add column native_prompt_id text;
create function public.track_native_webhook_prompt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.task_prompt_id is not null and (tg_op='INSERT' or new.task_prompt_id is distinct from old.task_prompt_id) then
    update public.account_turn_queue q set native_prompt_id=new.task_prompt_id
      where q.sandbox_id=new.id and q.owner_id=new.owner_id and q.org_id=new.org_id
        and q.state='dispatching' and q.native_prompt_id is null;
  end if;
  if new.task_prompt_id is not null and new.provider in ('boat','modal')
    and not new.boat_runtime and new.runtime_transport is distinct from 'dialout' then
    insert into public.native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id)
    values(new.id,new.task_prompt_id,new.provider,new.provider_sandbox_id,new.owner_id,new.org_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.track_native_webhook_prompt() from public,anon,authenticated;
create trigger sandbox_native_webhook_prompt after insert or update of task_prompt_id on public.sandboxes
  for each row execute function public.track_native_webhook_prompt();
-- Seed existing current native turns; subsequent replacements are captured by
-- the trigger in the same transaction as publication of their provider ID.
insert into public.native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id)
select id,task_prompt_id,provider,provider_sandbox_id,owner_id,org_id from public.sandboxes
where task_prompt_id is not null and provider in ('boat','modal') and not boat_runtime
  and runtime_transport is distinct from 'dialout';
