-- Approximate machine-reported usage; unknown stays null. No JWT grants.
alter table public.docker_hosts
  add column stopped_sandbox_bytes bigint check (stopped_sandbox_bytes >= 0);
