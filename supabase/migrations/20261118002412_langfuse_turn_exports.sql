-- Queue only terminal turn identities. Transcript payloads stay in their existing stores.
create table public.langfuse_turn_exports (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider_sandbox_id text not null,
  runtime_ack bigint,
  terminal_status text not null check (terminal_status in ('finished','failed','interrupted')),
  observed_at timestamptz not null default clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  primary key (sandbox_id,prompt_id)
);
create index langfuse_turn_exports_due on public.langfuse_turn_exports(observed_at) where completed_at is null;
create table public.org_langfuse_export_stats (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  exported bigint not null default 0,
  failed bigint not null default 0,
  dropped bigint not null default 0,
  last_export_at timestamptz
);
alter table public.langfuse_turn_exports enable row level security;
alter table public.org_langfuse_export_stats enable row level security;
revoke all on public.langfuse_turn_exports,public.org_langfuse_export_stats from public,anon,authenticated;
grant all on public.langfuse_turn_exports,public.org_langfuse_export_stats to service_role;

-- This existing settlement boundary is shared by runtime ingestion, native
-- receipt observation, and native lifecycle reconciliation.
create or replace function public.enqueue_webhook_turn(sandbox uuid,prompt text,status text) returns void
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
  insert into public.langfuse_turn_exports(sandbox_id,prompt_id,org_id,provider_sandbox_id,runtime_ack,terminal_status)
  select saved.id,prompt,saved.org_id,saved.provider_sandbox_id,
    case when saved.boat_runtime or saved.provider='docker' or saved.runtime_transport='dialout' then
      coalesce((select max(sequence) from public.runtime_events where sandbox_id=saved.id),0) end,
    status
  from public.org_langfuse c
  where c.org_id=saved.org_id and c.enabled and saved.provider_sandbox_id is not null
  on conflict do nothing;
  event_type := case when status='finished' then 'turn.finished' else 'turn.failed' end;
  for endpoint in select id from public.outbound_webhook_endpoints
    where org_id=saved.org_id and enabled loop
    delivery_id := gen_random_uuid();
    insert into public.outbound_webhook_deliveries(id,endpoint_id,payload)
    values(delivery_id,endpoint.id,jsonb_build_object(
      'id',delivery_id,'type',event_type,'occurredAt',clock_timestamp(),
      'orgId',saved.org_id,'sandboxId',saved.id,'promptId',prompt,
      'state',status,'externalRef',to_jsonb(saved)->'external_ref',
      'reason',case when status='interrupted' then 'interrupted'
        when status='failed' then 'turn_failed' else null end))
    on conflict do nothing;
  end loop;
end;
$$;
