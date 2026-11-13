-- Internal logical-sandbox authority on the existing encrypted host mailbox.
alter table public.docker_host_jobs
  add column bound_sandbox_id uuid references public.sandboxes(id) on delete restrict,
  add column bound_actor_id uuid references auth.users(id) on delete restrict,
  add column bound_actor_epoch bigint,
  add column bound_operation text,
  add constraint docker_host_jobs_bound_check check (
    (bound_sandbox_id is null and bound_actor_id is null and bound_actor_epoch is null and bound_operation is null)
    or (bound_sandbox_id is not null and bound_actor_id is not null and bound_actor_epoch is not null
      and bound_actor_epoch >= 0 and bound_operation is not null
      and bound_operation in ('create','bootstrap','stop','delete'))
  );
create unique index docker_host_jobs_bound_phase on public.docker_host_jobs(bound_sandbox_id,bound_operation)
  where bound_operation in ('create','bootstrap');
revoke all (bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation)
  on public.docker_host_jobs from public,anon,authenticated;
