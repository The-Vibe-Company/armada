-- Only the scheduler writes closed, value-free refusal codes; never raw exception text.
alter table public.routine_runs add column launch_refusal text;
grant select(launch_refusal) on public.routine_runs to authenticated;
