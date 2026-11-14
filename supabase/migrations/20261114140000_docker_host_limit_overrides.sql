-- Owner-configured policy; service-only writes, no new JWT grants.
alter table public.docker_hosts
  add column sandbox_cpus double precision,
  add column sandbox_memory_bytes bigint,
  add column max_sandboxes integer,
  add column resource_policy_version integer,
  add constraint docker_host_cpu_override_valid check (sandbox_cpus is null or
    (sandbox_cpus >= 0.01 and sandbox_cpus < 'Infinity'::double precision)),
  add constraint docker_host_memory_override_valid check (sandbox_memory_bytes is null or
    (sandbox_memory_bytes >= 6291456)),
  add constraint docker_host_max_override_valid check (max_sandboxes is null or max_sandboxes > 0),
  add constraint docker_host_policy_version_valid check (resource_policy_version is null or resource_policy_version = 1);
