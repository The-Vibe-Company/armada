alter table public.docker_host_jobs
  add column result_machine_id text check (
    result_machine_id is null or (
      result_machine_id ~ '^[a-f0-9]{64}$'
      and outcome is not distinct from 'completed'
      and bound_sandbox_id is not null
      and bound_operation is not null
      and bound_operation in ('create', 'restore')
    )
  );
