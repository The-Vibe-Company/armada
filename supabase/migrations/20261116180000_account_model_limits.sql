-- Model caps share the credential ownership boundary and account row lock.
alter table public.credentials add column model_limits jsonb not null default '{}'::jsonb
  check (jsonb_typeof(model_limits)='object');
grant select(model_limits) on public.credentials to authenticated;
alter table public.account_agent_reservations add column model text;
alter table public.account_turn_queue add column model text;
update public.account_turn_queue q set model=s.model from public.sandboxes s where s.id=q.sandbox_id;
