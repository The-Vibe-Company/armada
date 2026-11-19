create table public.trigger_admin_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  trigger_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in ('rotate', 'disable')),
  occurred_at timestamptz not null default clock_timestamp()
);

alter table public.trigger_admin_audit enable row level security;
revoke all on public.trigger_admin_audit from public, anon, authenticated, service_role;
grant select, insert on public.trigger_admin_audit to service_role;
