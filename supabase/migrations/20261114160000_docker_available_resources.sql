-- Authenticated machine observations only; no new JWT grants.
alter table public.docker_hosts
  add column available_cpus double precision,
  add column available_memory_bytes bigint,
  add constraint docker_host_availability_valid check (
    (available_cpus is null and available_memory_bytes is null) or
    (available_cpus is not null and available_memory_bytes is not null and
     available_cpus >= 0 and available_cpus <= machine_cpus and
     available_cpus < 'Infinity'::double precision and
     available_memory_bytes >= 0 and available_memory_bytes <= machine_memory_bytes)
  );
