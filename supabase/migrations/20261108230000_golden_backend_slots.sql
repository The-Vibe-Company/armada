-- Server-only capacity reservations for backend goldens. Reservation protocol follows in a later migration.
create table public.golden_backend_slots (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (length(btrim(provider)) > 0),
  backend_id text not null check (length(btrim(backend_id)) > 0),
  max_goldens integer not null check (max_goldens > 0),
  org_id uuid not null references public.orgs(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  golden_id uuid references public.goldens(id) on delete restrict,
  build_id uuid,
  created_at timestamptz not null default now(),
  check ((golden_id is null) <> (build_id is null))
);

alter table public.golden_backend_slots enable row level security;
revoke all on table public.golden_backend_slots from public, anon, authenticated;
grant all on table public.golden_backend_slots to service_role;
