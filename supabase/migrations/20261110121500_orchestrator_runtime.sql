-- #662 additive runtime storage; requires #661 migration 208. Feature remains off.
create table public.orchestrator_runtime (
 orchestrator_id uuid primary key references public.orchestrators(id),
 configuration jsonb not null check(jsonb_typeof(configuration)='object'),
 skill_revision text not null check(skill_revision ~ '^[a-f0-9]{40}$'),
 conversation_id text,
 checkpoint jsonb,
 provider_cursor text,
 continuity text not null default 'not_started' check(continuity in ('not_started','native','unverified','lost')),
 updated_at timestamptz not null default now(),
 last_activity_at timestamptz not null default now(),
 idle_deadline timestamptz,
 blocked_reason text,
 created_at timestamptz not null default now()
);
create table public.orchestrator_runtime_create_keys (
 owner_id uuid not null references auth.users(id),
 org_id uuid not null references public.orgs(id),
 idempotency_key text not null check(length(idempotency_key) between 1 and 128 and idempotency_key !~ '[^ -~]'),
 request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
 orchestrator_id uuid not null references public.orchestrators(id),
 primary key(owner_id,org_id,idempotency_key)
);
create table public.orchestrator_runtime_events (
 sequence bigint generated always as identity primary key,
 orchestrator_id uuid not null references public.orchestrators(id),
 revision bigint not null,
 generation bigint,
 conversation_id text,
 upstream_id text,
 event jsonb not null,
 created_at timestamptz not null default now(),
 unique(orchestrator_id,generation,conversation_id,upstream_id)
);
create index on public.orchestrator_runtime_events(orchestrator_id,sequence);
alter table public.orchestrator_runtime enable row level security;
alter table public.orchestrator_runtime_create_keys enable row level security;
alter table public.orchestrator_runtime_events enable row level security;
revoke all on public.orchestrator_runtime,public.orchestrator_runtime_create_keys,public.orchestrator_runtime_events from public,anon,authenticated;
revoke all on sequence public.orchestrator_runtime_events_sequence_seq from public,anon,authenticated;
grant all on public.orchestrator_runtime,public.orchestrator_runtime_create_keys,public.orchestrator_runtime_events to service_role;
grant all on sequence public.orchestrator_runtime_events_sequence_seq to service_role;
-- Reads also use owner/current-membership server policy. No direct JWT write surface.

-- Safe correlated native stop receipt/dispatch fence; no token/checkpoint bytes.
-- #663 owns lifecycle publication; read-only reconciliation never repeats the effect.
alter table public.orchestrator_operations add column runtime_result jsonb;
