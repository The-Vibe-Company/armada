begin;

-- Admit generation-fenced restore intents to the existing bound mailbox.
alter table public.docker_host_jobs
  drop constraint docker_host_jobs_bound_check,
  add constraint docker_host_jobs_bound_check check (
    (snapshot_id is null and bound_sandbox_id is null and bound_actor_id is null and bound_actor_epoch is null and bound_operation is null)
    or (snapshot_id is null and bound_sandbox_id is not null and bound_actor_id is not null and bound_actor_epoch is not null
      and bound_actor_epoch>=0 and bound_operation in ('create','bootstrap','resume','stop','delete','deletePhysical','restore'))
    or (snapshot_id is not null and bound_sandbox_id is null and bound_actor_id is not null and bound_actor_epoch is not null
      and bound_actor_epoch>=0 and bound_operation='buildSnapshot')
  );

create unique index docker_host_jobs_pending_restore
  on public.docker_host_jobs(host_id,bound_sandbox_id)
  where bound_operation='restore' and outcome is null;

commit;
