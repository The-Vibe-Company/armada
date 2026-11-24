begin;

-- Machine bootstrap slots are keyed by the bound daemon generation's deterministic
-- request ID. The legacy bootstrap admission still fences its singleton under the host lock.
drop index public.docker_host_jobs_bound_phase;
create unique index docker_host_jobs_bound_create on public.docker_host_jobs(bound_sandbox_id)
  where bound_operation = 'create';

commit;
