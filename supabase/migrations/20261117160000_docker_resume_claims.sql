-- Machine acknowledgements, never JWT-visible. A pending request is not admission.
create table public.docker_resume_claims (
  request_id uuid primary key,
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  host_id uuid not null references public.docker_hosts(id) on delete cascade,
  installation_id uuid not null,
  generation uuid not null,
  actor_id uuid not null references auth.users(id) on delete cascade,
  lifecycle_generation bigint not null,
  unique(sandbox_id,lifecycle_generation),
  accepted boolean
);
alter table public.docker_resume_claims enable row level security;
revoke all on public.docker_resume_claims from public, anon, authenticated;
grant all on public.docker_resume_claims to service_role;
