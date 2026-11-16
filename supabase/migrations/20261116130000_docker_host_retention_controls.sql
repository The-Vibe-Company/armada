-- User-facing policy is delivered to, and enforced durably by, the host daemon.
alter table public.docker_hosts
  add column retention_seconds integer check (retention_seconds between 0 and 31536000),
  add column reported_retention_seconds integer check (reported_retention_seconds between 0 and 31536000),
  add column next_cleanup_at timestamptz;
-- No JWT grants: host controls and telemetry use the authenticated control API.
