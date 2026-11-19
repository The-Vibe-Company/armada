-- Allow a separately bound receipt for container-only cleanup.
alter table public.docker_host_jobs
  drop constraint docker_host_jobs_bound_check,
  add constraint docker_host_jobs_bound_check check (
    (snapshot_id is null and bound_sandbox_id is null and bound_actor_id is null and bound_actor_epoch is null and bound_operation is null)
    or (snapshot_id is null and bound_sandbox_id is not null and bound_actor_id is not null and bound_actor_epoch is not null
      and bound_actor_epoch>=0 and bound_operation in ('create','bootstrap','resume','stop','delete','deletePhysical'))
    or (snapshot_id is not null and bound_sandbox_id is null and bound_actor_id is not null and bound_actor_epoch is not null
      and bound_actor_epoch>=0 and bound_operation='buildSnapshot')
  );
