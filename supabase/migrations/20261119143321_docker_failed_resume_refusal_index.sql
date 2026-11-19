create index docker_host_jobs_failed_resume_refusal on public.docker_host_jobs(host_id,position)
  where refused_resume_generation is not null and outcome='failed' and cancelled_at is null;
