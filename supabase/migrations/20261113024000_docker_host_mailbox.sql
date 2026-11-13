-- Internal service mailbox only; no user-JWT access and no launch placement integration.
create table public.docker_hosts (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  registration_hash text unique check (registration_hash ~ '^[0-9a-f]{64}$'),
  registration_expires_at timestamptz not null,
  installation_id uuid,
  hash text unique check (hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check ((installation_id is null) = (hash is null)),
  check (hash is null or registration_hash is null)
);

create table public.docker_host_jobs (
  request_id uuid primary key,
  host_id uuid not null references public.docker_hosts(id) on delete cascade,
  position bigserial unique not null,
  input_enc bytea not null check (octet_length(input_enc) > 28),
  outcome text check (outcome in ('completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((outcome is null) = (completed_at is null))
);
create index docker_host_jobs_pending on public.docker_host_jobs(host_id, position) where outcome is null;

alter table public.docker_hosts enable row level security;
alter table public.docker_host_jobs enable row level security;
revoke all on public.docker_hosts, public.docker_host_jobs from public, anon, authenticated;
revoke all on sequence public.docker_host_jobs_position_seq from public, anon, authenticated;
grant all on public.docker_hosts, public.docker_host_jobs to service_role;
grant all on sequence public.docker_host_jobs_position_seq to service_role;
