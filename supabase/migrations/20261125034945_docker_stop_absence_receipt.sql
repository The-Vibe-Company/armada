alter table public.docker_host_jobs
  add column absent_machine_id text check (
    absent_machine_id is null or (
      bound_operation is not distinct from 'stop' and outcome is not distinct from 'completed'
      and result_machine_id is null and absent_machine_id ~ '^[a-f0-9]{64}$'
    )
  );
