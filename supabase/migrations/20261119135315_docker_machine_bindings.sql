-- Machine incarnations outlive the mutable sandbox row and are scoped to one host installation.
create table public.docker_machine_bindings (
  sandbox_id uuid not null,
  machine_generation bigint not null check (machine_generation between 0 and 9007199254740991),
  host_id uuid not null,
  installation_id uuid not null,
  daemon_generation uuid not null default gen_random_uuid(),
  primary key (sandbox_id, machine_generation),
  unique (host_id, installation_id, sandbox_id, daemon_generation)
);

alter table public.docker_machine_bindings enable row level security;
revoke all on public.docker_machine_bindings from public, anon, authenticated, service_role;
grant select, insert on public.docker_machine_bindings to service_role;
