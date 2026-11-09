-- Bounded machine lifetime, independent of conversation activity. Never deletes data.
alter table public.sandboxes
  add column requested_ttl_seconds integer check (requested_ttl_seconds > 0),
  add column effective_ttl_seconds integer not null default 14400 check (effective_ttl_seconds > 0),
  add column expires_at timestamptz,
  add column lifecycle_generation bigint not null default 1,
  add column last_observed_at timestamptz,
  add column lifecycle_error text,
  add column reconcile_after timestamptz not null default now(),
  add column stop_requested_at timestamptz,
  add column activity_lease_id uuid,
  add column activity_until timestamptz,
  add column reconcile_lease uuid,
  add column reconcile_lease_until timestamptz;
update public.sandboxes set expires_at = created_at + interval '4 hours';
alter table public.sandboxes alter column expires_at set not null;
alter table public.sandboxes alter column expires_at set default (now() + interval '4 hours');
grant select (requested_ttl_seconds,effective_ttl_seconds,expires_at,lifecycle_generation,last_observed_at,lifecycle_error) on public.sandboxes to authenticated;
create index sandboxes_reconcile_due on public.sandboxes(reconcile_after) where status not in ('stopped','deleted')
  and not (status='failed' and stopped_at is not null);
