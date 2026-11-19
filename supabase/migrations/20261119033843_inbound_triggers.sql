create table public.triggers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  template_id uuid not null references public.launch_templates(id),
  launch_owner_id uuid not null references auth.users(id),
  -- The owner's agent_defaults row identifies the pool by (user_id, harness).
  -- Clearing the row makes the binding unavailable while preserving receipts.
  pool_harness text not null check (pool_harness in ('claude', 'codex', 'opencode')),
  secret_enc bytea not null,
  key_revision integer not null default 1 check (key_revision > 0),
  rate_per_minute integer not null check (rate_per_minute > 0),
  concurrency integer not null check (concurrency > 0),
  enabled boolean not null default true,
  rate_refusals integer not null default 0 check (rate_refusals >= 0)
);

create table public.trigger_deliveries (
  trigger_id uuid not null references public.triggers(id) on delete cascade,
  delivery_id text not null check (delivery_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  job_id uuid not null unique references public.jobs(id),
  received_at timestamptz not null,
  primary key (trigger_id, delivery_id)
);

create index trigger_deliveries_rate on public.trigger_deliveries (trigger_id, received_at);

alter table public.triggers enable row level security;
alter table public.trigger_deliveries enable row level security;
revoke all on public.triggers, public.trigger_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.triggers, public.trigger_deliveries to service_role;
