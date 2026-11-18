-- Queue only terminal turn identities. Transcript payloads stay in their existing stores.
create table public.langfuse_turn_exports (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider_sandbox_id text not null,
  runtime_ack bigint,
  terminal_status text check (terminal_status in ('finished','failed','interrupted')),
  -- Content mode allowed when the turn settled. Delivery uses the more
  -- restrictive of this and the current setting, so a later switch to full
  -- never discloses a turn that settled under metadata.
  allowed_content_mode text check (allowed_content_mode in ('metadata','full')),
  observed_at timestamptz not null default clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  -- Claims reserve an attempt so repeated aborted ticks still reach a durable outcome.
  attempts smallint not null default 0,
  completed_at timestamptz,
  check (terminal_status is not null or completed_at is not null),
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

-- Remember native terminal identities that were already observed before rollout.
insert into public.langfuse_turn_exports(sandbox_id,prompt_id,org_id,provider_sandbox_id,completed_at)
select s.id,known.prompt_id,s.org_id,s.provider_sandbox_id,clock_timestamp()
from (
  select sandbox_id,prompt_id from public.native_webhook_prompts where completed_at is not null
  union
  select sandbox_id,prompt_id from public.runtime_idle_turns where settled
) known join public.sandboxes s on s.id=known.sandbox_id
where s.provider in ('boat','modal') and s.provider_sandbox_id is not null
  and not s.boat_runtime and s.runtime_transport is distinct from 'dialout';

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
  -- Record native identities even while disabled: lifecycle can observe the
  -- same receipt again after an operator enables full-content export.
  insert into public.langfuse_turn_exports(
    sandbox_id,prompt_id,org_id,provider_sandbox_id,runtime_ack,terminal_status,allowed_content_mode,completed_at
  )
  select saved.id,prompt,saved.org_id,saved.provider_sandbox_id,
    case when saved.boat_runtime or saved.provider='docker' or saved.runtime_transport='dialout' then
      coalesce((select max(sequence) from public.runtime_events where sandbox_id=saved.id),0) end,
    status,case when c.enabled then c.content_mode end,
    case when not coalesce(c.enabled,false) then clock_timestamp() end
  from (values (saved.org_id)) as owner(org_id)
  left join public.org_langfuse c on c.org_id=owner.org_id
  where saved.provider_sandbox_id is not null
    and (c.enabled or (not saved.boat_runtime and saved.provider in ('boat','modal')
      and saved.runtime_transport is distinct from 'dialout'))
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

-- An accepted native steer can answer with a steer record while its replacement
-- run appears only later. Keep the last concrete run before it as a cursor so
-- the native receipt worker can register every later run as a receipt, even
-- after the sandbox stopped. lease_until also spaces out retries of a pass.
-- pending_steers counts accepted steers whose own replacement is not yet
-- registered; the cursor stays pending until each has one.
create table public.native_steer_cursors (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  after_prompt_id text,
  steer_id uuid not null,
  pending_since timestamptz,
  pending_steers integer not null default 0 check (pending_steers >= 0),
  lease_id uuid,
  lease_until timestamptz,
  check (after_prompt_id is distinct from '')
);
alter table public.native_steer_cursors enable row level security;
revoke all on public.native_steer_cursors from public,anon,authenticated;
grant all on public.native_steer_cursors to service_role;

-- An empty task_prompt_id is the marker for a steered run that is not known
-- yet. It stays on the sandbox for report resolution, but it names no provider
-- run, so it is never a native receipt (a receipt for it could only fail and
-- count a false drop). The queue alias behaviour is unchanged.
create or replace function public.track_native_webhook_prompt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.task_prompt_id is not null and (tg_op='INSERT' or new.task_prompt_id is distinct from old.task_prompt_id) then
    update public.account_turn_queue q set native_prompt_id=new.task_prompt_id
      where q.sandbox_id=new.id and q.owner_id=new.owner_id and q.org_id=new.org_id
        and q.state='dispatching' and q.native_prompt_id is null;
  end if;
  if new.task_prompt_id is not null and new.task_prompt_id<>'' and new.provider in ('boat','modal')
    and not new.boat_runtime and new.runtime_transport is distinct from 'dialout' then
    insert into public.native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id)
    values(new.id,new.task_prompt_id,new.provider,new.provider_sandbox_id,new.owner_id,new.org_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.track_native_webhook_prompt() from public,anon,authenticated;
delete from public.native_webhook_prompts where prompt_id='';
-- The receipt worker finalizes exhausted receipts whose final lease expired.
create index native_webhook_prompts_expired_final on public.native_webhook_prompts(lease_until)
  where completed_at is null and failures>=5 and lease_id is not null;
-- Final claims abandoned before this rollout predate durable drop accounting:
-- release them without counting, like the already-observed turns seeded above.
update public.native_webhook_prompts set lease_id=null,lease_until=null
where completed_at is null and failures>=5 and lease_id is not null and lease_until<now();
