-- Machine-reported observation only; existing host control authorization owns access.
alter table public.docker_hosts
  add column disk_free_bytes bigint check (disk_free_bytes >= 0);
-- No JWT grants: host telemetry and list access use the authenticated control API.
