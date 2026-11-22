begin;

set local lock_timeout = '2s';
set local statement_timeout = '5s';

-- Writers take the existing sandbox lock before writing this service-only row.
-- Admission checks the job's kind, sandbox and generation under that lock.
create table public.boat_runtime_extension_state (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  pending_job_id uuid references public.jobs(id),
  observed_provider_id text,
  observed_generation bigint,
  observed_at timestamptz,
  observed_expires_at timestamptz,
  constraint boat_runtime_observation_complete check (
    num_nonnulls(observed_provider_id, observed_generation, observed_at, observed_expires_at) = 0
    or (
      num_nonnulls(observed_provider_id, observed_generation, observed_at, observed_expires_at) = 4
      and observed_provider_id <> ''
      and observed_generation > 0
      and isfinite(observed_at)
      and isfinite(observed_expires_at)
    )
  )
);

-- A historical observation may survive a binding change. Match its provider ID
-- and lifecycle generation to the current sandbox before using it as evidence.
alter table public.boat_runtime_extension_state enable row level security;
revoke all on public.boat_runtime_extension_state from public, anon, authenticated;
grant select, insert, update, delete on public.boat_runtime_extension_state to service_role;

commit;
