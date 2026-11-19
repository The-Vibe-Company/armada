alter table public.docker_host_jobs add column refused_resume_generation bigint;

create index docker_host_jobs_refused_resume on public.docker_host_jobs(host_id,position)
  where refused_resume_generation is not null and outcome='completed' and cancelled_at is null;
