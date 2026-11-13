-- Resume reuses the original machine identity and frozen TTL, with a fresh bootstrap capability.
alter table public.docker_host_jobs drop constraint docker_host_jobs_bound_check;
alter table public.docker_host_jobs add constraint docker_host_jobs_bound_check check (
  (bound_sandbox_id is null and bound_actor_id is null and bound_actor_epoch is null and bound_operation is null)
  or (bound_sandbox_id is not null and bound_actor_id is not null and bound_actor_epoch is not null
    and bound_actor_epoch >= 0 and bound_operation is not null
    and bound_operation in ('create','bootstrap','resume','stop','delete'))
);
