begin;

-- These tables have no runtime callers in v13.0.0 or in the release baseline.
drop table public.orchestrator_activity;
drop table public.orchestrator_lifecycle_mutations;
drop table public.orchestrator_operations;
drop table public.orchestrator_runtime;
drop table public.orchestrator_runtime_create_keys;
drop table public.orchestrator_runtime_events;
drop table public.orchestrator_waits;

commit;
