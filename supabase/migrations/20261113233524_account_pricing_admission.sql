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

-- New inserts from an older writer explicitly lack provenance rather than masquerading as legacy history.
alter table public.sandbox_turn_models alter column pricing_context set default 'null'::jsonb;
-- Runtime usage can precede its accepted RPC receipt; the live epoch owns the pre-work account book.
alter table public.runtime_enrolments add column pricing_context jsonb
  check (pricing_context is null or jsonb_typeof(pricing_context) in ('object','null'));
-- Follow actual token revocation, not lifecycle-generation changes that intentionally hand off a live epoch.
create function public.clear_runtime_pricing_on_revocation() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.runtime_hash is null and new.enrolment_hash is null then new.pricing_context=null; end if;
  return new;
end $$;
revoke all on function public.clear_runtime_pricing_on_revocation() from public,anon,authenticated;
create trigger clear_runtime_pricing_on_revocation before update of runtime_hash,enrolment_hash on public.runtime_enrolments
  for each row execute function public.clear_runtime_pricing_on_revocation();
