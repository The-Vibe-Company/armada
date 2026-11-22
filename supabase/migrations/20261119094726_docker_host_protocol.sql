-- Daemons report this after their first accepted poll. Existing rows remain readable.
alter table public.docker_hosts add column daemon_protocol integer check (daemon_protocol >= 0);
