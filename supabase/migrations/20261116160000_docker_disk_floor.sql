-- Machine-only heartbeat telemetry. Unknown/old reports never invent free disk capacity.
alter table public.docker_hosts
  add column free_disk_bytes bigint,
  add column disk_floor_bytes bigint,
  add constraint docker_hosts_free_disk_bytes_chk check (free_disk_bytes is null or free_disk_bytes between 0 and 9007199254740991),
  add constraint docker_hosts_disk_floor_bytes_chk check (disk_floor_bytes is null or disk_floor_bytes between 0 and 9007199254740991);
comment on column public.docker_hosts.free_disk_bytes is 'Available bytes on the verified local Docker data filesystem at the last heartbeat; null means unknown.';
comment on column public.docker_hosts.disk_floor_bytes is 'Daemon-enforced minimum available Docker data bytes; null means no disk-report support. Default 10 GiB (10737418240 bytes).';
