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
  result_enc bytea,
  failure_reason text,
  primary key (sandbox_id,request_id)
);
alter table public.account_turn_queue enable row level security;
revoke all on public.account_turn_queue from anon, authenticated;
grant all on public.account_turn_queue to service_role;
create index account_turn_queue_waiting on public.account_turn_queue(account_id,sequence) where state='queued';
