-- Account switches admit a new immutable pricing book; the original launch book stays historical evidence.
create table public.sandbox_account_usage_pricing (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  credential_id uuid not null,
  credential_version integer not null check (credential_version > 0),
  context jsonb not null check (jsonb_typeof(context) in ('object','null')),
  created_at timestamptz not null default now(),
  primary key (sandbox_id,credential_id,credential_version)
);
alter table public.sandbox_account_usage_pricing enable row level security;
revoke all on public.sandbox_account_usage_pricing from public,anon,authenticated,service_role;
grant select,insert on public.sandbox_account_usage_pricing to service_role;
create trigger sandbox_account_usage_pricing_immutable before update on public.sandbox_account_usage_pricing
  for each row execute function public.keep_sandbox_usage_pricing();

-- SQL NULL identifies legacy admissions; JSON null explicitly records unknown pricing on a new turn.
alter table public.sandbox_turn_models add column pricing_context jsonb
  check (pricing_context is null or jsonb_typeof(pricing_context) in ('object','null'));
create trigger sandbox_turn_pricing_context_immutable before update of pricing_context on public.sandbox_turn_models
  for each row when (old.pricing_context is distinct from new.pricing_context)
  execute function public.keep_sandbox_usage_pricing();
