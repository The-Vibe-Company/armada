-- Carry the journal identity from the BEFORE writer to the existing AFTER
-- publisher. Deliveries survive sandbox removal, so neither ID needs a FK.
alter table public.sandboxes add column last_status_transition_id bigint;
alter table public.outbound_webhook_deliveries add column sandbox_transition_id bigint;
create unique index outbound_webhook_status_identity
  on public.outbound_webhook_deliveries (endpoint_id, sandbox_transition_id)
  where sandbox_transition_id is not null;

create function public.enqueue_sandbox_webhook_event(
  saved public.sandboxes, event_type text, public_reason text, transition_id bigint
) returns void
language sql set search_path = '' as $$
  insert into public.outbound_webhook_deliveries (id, endpoint_id, payload, sandbox_transition_id)
  select event.id, endpoint.id, jsonb_build_object(
    'id', event.id, 'type', event_type, 'occurredAt', clock_timestamp(),
    'orgId', saved.org_id, 'sandboxId', saved.id, 'promptId', saved.task_prompt_id,
    'state', saved.status, 'externalRef', to_jsonb(saved)->'external_ref', 'reason', public_reason
  ), transition_id
  from public.outbound_webhook_endpoints endpoint
  cross join lateral (select gen_random_uuid() as id where endpoint.id is not null) event
  where endpoint.org_id = saved.org_id and endpoint.enabled
  on conflict (endpoint_id, sandbox_transition_id) where sandbox_transition_id is not null do nothing;
$$;
revoke all on function public.enqueue_sandbox_webhook_event(public.sandboxes, text, text, bigint)
  from public, anon, authenticated, service_role;

create function public.enqueue_sandbox_status_webhooks(saved public.sandboxes, transition_id bigint)
returns void
language plpgsql set search_path = '' as $$
begin
  if saved.status = 'stopped' then
    if saved.status_reason = 'expired' then
      perform public.enqueue_sandbox_webhook_event(saved, 'sandbox.expired', 'expired', transition_id);
    else
      perform public.enqueue_sandbox_webhook_event(saved, 'sandbox.stopped', null, transition_id);
    end if;
  elsif saved.status = 'deleted' then
    perform public.enqueue_sandbox_webhook_event(
      saved, 'sandbox.reclaimed',
      case when saved.status_reason in ('retention_elapsed', 'disk_pressure')
        then saved.status_reason else 'reclaimed' end,
      transition_id
    );
  end if;
end;
$$;
revoke all on function public.enqueue_sandbox_status_webhooks(public.sandboxes, bigint)
  from public, anon, authenticated, service_role;

create or replace function public.transition_sandbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.sandbox_transitions (sandbox_id, from_status, to_status, actor, code, generation)
    values (
      new.id, old.status, new.status,
      new.transition_context->>'actor', new.transition_context->>'code', new.lifecycle_generation
    )
    returning id into new.last_status_transition_id;

    perform public.enqueue_sandbox_status_webhooks(new, new.last_status_transition_id);
  end if;
  new.transition_context := null;
  return new;
end;
$$;

create or replace function public.enqueue_sandbox_webhooks() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    perform public.enqueue_sandbox_status_webhooks(
      new, case when new.last_status_transition_id is distinct from old.last_status_transition_id
        then new.last_status_transition_id end
    );
  end if;
  if new.task_outcome is not null and (new.task_outcome is distinct from old.task_outcome
    or new.task_prompt_id is distinct from old.task_prompt_id) then
    perform public.enqueue_sandbox_webhook_event(
      new, 'agent.report.' || (new.task_outcome->>'state'),
      case when new.task_outcome->>'state' = 'blocked' then 'agent_blocked' end, null
    );
  end if;
  return new;
end;
$$;
