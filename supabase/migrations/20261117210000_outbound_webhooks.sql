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
    if old.status='running' and new.status='ready' then
      event_types := array_append(event_types,'turn.finished');
    elsif new.status='failed' then
      event_types := array_append(event_types,'turn.failed');
    end if;
    if new.status='stopped' then
      event_types := array_append(event_types,case when new.status_reason='expired'
        then 'sandbox.expired' else 'sandbox.stopped' end);
    elsif new.status='deleted' and new.status_reason in ('retention_elapsed','disk_pressure') then
      event_types := array_append(event_types,'sandbox.reclaimed');
    end if;
  end if;
  if new.task_outcome is not null and (new.task_outcome is distinct from old.task_outcome
    or new.task_prompt_id is distinct from old.task_prompt_id) then
    event_types := array_append(event_types,'agent.report.'||(new.task_outcome->>'state'));
  end if;
  foreach event_type in array event_types loop
    public_reason := case
      when event_type='turn.failed' then 'turn_failed'
      when event_type='sandbox.expired' then 'expired'
      when event_type='sandbox.reclaimed' then new.status_reason
      when event_type='agent.report.blocked' then 'agent_blocked'
      else null end;
    for endpoint in select id from public.outbound_webhook_endpoints
      where org_id=new.org_id and enabled loop
      delivery_id := gen_random_uuid();
      insert into public.outbound_webhook_deliveries(id,endpoint_id,payload)
      values(delivery_id,endpoint.id,jsonb_build_object(
        'id',delivery_id,'type',event_type,'occurredAt',clock_timestamp(),
        'orgId',new.org_id,'sandboxId',new.id,'promptId',new.task_prompt_id,
        'state',new.status,'externalRef',to_jsonb(new)->'external_ref','reason',public_reason));
    end loop;
  end loop;
  return new;
end;
$$;
revoke all on function public.enqueue_sandbox_webhooks() from public,anon,authenticated;
create trigger sandbox_outbound_webhooks after update of status,task_outcome,task_prompt_id on public.sandboxes
  for each row execute function public.enqueue_sandbox_webhooks();
