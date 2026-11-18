-- Storage for future durable Boat and Modal admission. No launch path writes
-- this table until the readers and controls support pre-allocation sandboxes.
create table public.provider_launch_requests (
  -- Ordinary admission uses the receipt ID as the sandbox and provider request key.
  -- Cleanup must finish before the server removes the request and its sandbox.
  sandbox_id uuid primary key references public.sandboxes(id) on delete restrict,
  actor_epoch bigint not null check (actor_epoch >= 0),
  request_enc bytea check (octet_length(request_enc) > 28),
  -- The worker clears this link only after durable child protection or verified absence.
  fence_id uuid unique references public.golden_operation_fences(id) on delete restrict,
  phase text not null default 'queued' check (phase in (
    'queued', 'resolving_snapshot', 'booting', 'preparing_harness',
    'reconciling', 'cleanup_pending', 'succeeded', 'failed', 'cancelled'
  )),
  dispatch_deadline timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  lease_owner uuid,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  lease_expires_at timestamptz,
  correlation_id uuid not null,
  outcome jsonb,
  created_at timestamptz not null default now(),
  constraint provider_launch_requests_receipt_fkey
    foreign key (sandbox_id) references public.ordinary_launch_receipts(id) on delete restrict,
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (request_enc is not null or phase in ('succeeded', 'failed', 'cancelled'))
);

create index provider_launch_requests_due_idx
  on public.provider_launch_requests (next_attempt_at, created_at, sandbox_id)
  where phase not in ('succeeded', 'failed', 'cancelled');

comment on column public.provider_launch_requests.request_enc is
  'Encrypted frozen launch inputs. Clear after execution and recovery finish.';
comment on column public.provider_launch_requests.outcome is
  'Safe launch outcome for status and support. Contains no prompts, secrets, or raw provider errors.';

alter table public.provider_launch_requests enable row level security;
revoke all on public.provider_launch_requests from public, anon, authenticated;
grant all on public.provider_launch_requests to service_role;
