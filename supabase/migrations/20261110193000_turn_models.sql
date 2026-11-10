-- Per-prompt provenance; the sandbox model remains the next-send default.
create table public.sandbox_turn_models (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  requested_model text,
  evidence jsonb,
  primary key (sandbox_id, prompt_id)
);
alter table public.sandbox_turn_models enable row level security;
revoke all on public.sandbox_turn_models from public, anon, authenticated;
grant all on public.sandbox_turn_models to service_role;
-- Only the server accesses this table, after authorizing sandbox interior access.
