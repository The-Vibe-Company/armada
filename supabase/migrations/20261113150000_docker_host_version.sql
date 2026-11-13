-- Service-only health metadata; no new user-JWT grants.
alter table public.docker_hosts add column daemon_version text;
alter table public.docker_hosts add column draining_at timestamptz;
