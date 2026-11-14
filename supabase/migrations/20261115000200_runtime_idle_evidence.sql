-- Server-only projections. No JWT grants: event contents remain encrypted.
create table public.runtime_idle_evidence (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  sequence bigint not null default 0,
  last_activity double precision not null default 0,
  unknown_turn boolean not null default false
);
create table public.runtime_idle_turns (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  settled boolean not null,
  primary key (sandbox_id, prompt_id)
);
create index runtime_idle_unsettled on public.runtime_idle_turns(sandbox_id) where not settled;
alter table public.runtime_idle_evidence enable row level security;
alter table public.runtime_idle_turns enable row level security;
revoke all on public.runtime_idle_evidence, public.runtime_idle_turns from public, anon, authenticated;
grant all on public.runtime_idle_evidence, public.runtime_idle_turns to service_role;
