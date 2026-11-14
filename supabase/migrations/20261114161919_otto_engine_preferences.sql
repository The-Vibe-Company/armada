-- A private per-member engine choice, with references only. Never stores credentials.
create table public.otto_engine_preferences (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  harness text not null check (harness in ('claude','codex','opencode')),
  model text not null check (length(model) between 1 and 200),
  credential_id uuid not null references public.credentials(id) on delete cascade,
  primary key (org_id,user_id)
);
alter table public.otto_engine_preferences enable row level security;
revoke all on public.otto_engine_preferences from anon, authenticated;
grant select on public.otto_engine_preferences to authenticated;
grant all on public.otto_engine_preferences to service_role;
-- Writes go through server preflight; JWT readers see only their own org-scoped references.
create policy otto_engine_read on public.otto_engine_preferences for select to authenticated
using (user_id = auth.uid() and exists (
  select 1 from public.members m where m.org_id = otto_engine_preferences.org_id and m.user_id = auth.uid()
));
