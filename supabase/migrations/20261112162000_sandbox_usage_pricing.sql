-- A session freezes its secret-free catalog before inference; legacy sessions have no invented historical prices.
create table public.sandbox_usage_pricing (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now()
);
alter table public.sandbox_usage_pricing enable row level security;
revoke all on public.sandbox_usage_pricing from public, anon, authenticated, service_role;
grant select, insert on public.sandbox_usage_pricing to service_role;
-- No update port: admission inserts use ON CONFLICT DO NOTHING. Restrict privileged accidental writes too.
create function public.keep_sandbox_usage_pricing() returns trigger language plpgsql as $$
begin
  raise exception 'Session usage pricing is immutable' using errcode = '23514';
end;
$$;
revoke all on function public.keep_sandbox_usage_pricing() from public, anon, authenticated;
create trigger sandbox_usage_pricing_immutable before update on public.sandbox_usage_pricing
  for each row execute function public.keep_sandbox_usage_pricing();
