-- Historical insertion times are unknown. Set defaults separately to leave existing
-- rows undated and avoid rewriting either runtime journal.
alter table public.runtime_commands add column created_at timestamptz;
alter table public.runtime_events add column created_at timestamptz;

alter table public.runtime_commands alter column created_at set default clock_timestamp();
alter table public.runtime_events alter column created_at set default clock_timestamp();
