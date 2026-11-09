-- Server-owned durable admission queue. User JWTs never read payload ciphertext.
create table public.golden_build_jobs (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  owner_id uuid not null references auth.users(id),
  name text not null,
  visibility text not null check (visibility in ('org','private')),
  idempotency_key text not null,
  request_hash text not null,
  payload_enc bytea not null,
  reservation_id uuid not null unique,
  state text not null default 'queued'
    check (state in ('queued','running','recovery_required','succeeded','failed')),
  phase text not null default 'queued' check (phase in ('queued','authorization','builder','checkout_credentials','checkout_baseline','secret_scan','snapshot','persist','complete')),
  fence uuid,
  lease_until timestamptz,
  deadline timestamptz,
  builder_id text,
  snapshot text,
  golden_id uuid references public.goldens(id),
  error_code text check (error_code is null or error_code = 'build_failed'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'running' or (fence is not null and lease_until is not null and deadline is not null)),
  check (state <> 'succeeded' or (golden_id is not null and snapshot is not null and error_code is null)),
  check (state not in ('failed','recovery_required') or error_code = 'build_failed'),
  unique (owner_id, org_id, idempotency_key)
);
alter table public.golden_build_jobs enable row level security;
revoke all on public.golden_build_jobs from anon, authenticated;
grant all on public.golden_build_jobs to service_role;
create index golden_build_jobs_queue on public.golden_build_jobs(state, created_at);
