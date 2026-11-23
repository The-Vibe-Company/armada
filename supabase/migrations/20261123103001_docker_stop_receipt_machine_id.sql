begin;

alter table public.docker_host_jobs
  drop constraint docker_host_jobs_check1,
  add constraint docker_host_jobs_result_machine_id_check check (
    result_machine_id is null or (
      result_machine_id ~ '^[a-f0-9]{64}$'
      and outcome is not distinct from 'completed'
      and bound_sandbox_id is not null
      and bound_operation is not null
      and bound_operation in ('create', 'restore', 'stop')
    )
  );

commit;
