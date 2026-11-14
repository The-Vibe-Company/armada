-- Accepted owner instructions while a normal Docker launch prepares. Prompt text remains sealed.
create table public.docker_queued_prompts (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 request_id uuid not null,
 prompt_id uuid not null unique,
 owner_id uuid not null references auth.users(id) on delete cascade,
 actor_epoch bigint not null,
 lifecycle_generation bigint not null,
 position bigint generated always as identity,
 input_enc bytea not null check(octet_length(input_enc)>28),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'queued' check(status in ('queued','dispatching','admitted','failed')),
 native_prompt_id uuid,
 native_conversation_id uuid,
 failure_reason text check(length(failure_reason)<=512),
 failure_native_sequence bigint,
 worker_id uuid,
 worker_expires_at timestamptz,
 created_at timestamptz not null default now(),
 primary key(sandbox_id,request_id)
);
alter table public.docker_queued_prompts enable row level security;
revoke all on public.docker_queued_prompts from public,anon,authenticated;
grant all on public.docker_queued_prompts to service_role;
create index docker_queued_prompts_pending on public.docker_queued_prompts(position) where status in ('queued','dispatching');

revoke all on sequence public.docker_queued_prompts_position_seq from public,anon,authenticated;
grant usage,select on sequence public.docker_queued_prompts_position_seq to service_role;
