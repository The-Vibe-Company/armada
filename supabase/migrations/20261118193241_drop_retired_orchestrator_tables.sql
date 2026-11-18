-- The owner-facing orchestrator paths were removed in #1396.
-- RESTRICT makes unexpected dependencies on these tables fail the migration.
drop table
  public.orchestrator_activity,
  public.orchestrator_lifecycle_mutations,
  public.orchestrator_operations,
  public.orchestrator_runtime,
  public.orchestrator_runtime_create_keys,
  public.orchestrator_runtime_events,
  public.orchestrator_waits
restrict;
