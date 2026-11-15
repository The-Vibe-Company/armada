-- Personal selections are independent for each coding agent, including shared accounts.
create table public.agent_defaults (
  user_id uuid not null references auth.users(id) on delete cascade,
  harness text not null check (harness in ('claude','codex','opencode')),
  credential_id uuid references public.credentials(id) on delete set null,
  model text check (model is null or (length(model) between 1 and 256 and model !~ '[[:space:]]')),
  primary key (user_id,harness)
);
alter table public.agent_defaults enable row level security;
revoke all on public.agent_defaults from public, anon, authenticated;
grant all on public.agent_defaults to service_role;
