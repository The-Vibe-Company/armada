-- Hardware observations are written only by the authenticated machine heartbeat.
-- Existing installations remain capacity-unknown until an upgraded daemon polls.
alter table public.docker_hosts
  add column machine_cpus double precision,
  add column machine_memory_bytes bigint,
  add constraint docker_host_resources_valid check (
    (machine_cpus is null and machine_memory_bytes is null) or
    (machine_cpus is not null and machine_memory_bytes is not null and
     machine_cpus > 0 and machine_cpus < 'Infinity'::double precision and
     machine_memory_bytes >= 6291456 and machine_memory_bytes <= 9007199254740991)
  );
-- No JWT grants: the server checks org/host visibility before exposing metadata.
