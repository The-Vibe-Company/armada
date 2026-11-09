-- Additive, server-owned evidence only. Historical project/capacity evidence is not reconstructed.
alter table public.sandboxes add column resource_project jsonb;
grant select (resource_project) on public.sandboxes to authenticated;
create function public.guard_resource_project() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.resource_project is distinct from old.resource_project then
    raise exception 'Launch resource project is immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_resource_project() from public,anon,authenticated;
create trigger sandboxes_resource_project_immutable before update on public.sandboxes
for each row execute function public.guard_resource_project();

create table public.resource_observations (
  id bigint generated always as identity primary key,
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  physical_id text not null check (length(physical_id) between 1 and 512),
  generation text not null check (length(generation) between 1 and 256),
  boot_id uuid not null,
  uptime_ms double precision not null check (uptime_ms >= 0 and uptime_ms < 'Infinity'::double precision),
  observed_at timestamptz not null,
  observation jsonb not null check (jsonb_typeof(observation)='object' and octet_length(observation::text)<=16384),
  unique (sandbox_id,physical_id,generation,boot_id,uptime_ms)
);
create index resource_observations_recent on public.resource_observations (sandbox_id,id desc);
create index resource_observations_expiry on public.resource_observations (observed_at);
alter table public.resource_observations enable row level security;
revoke all on public.resource_observations from public,anon,authenticated;
revoke all on sequence public.resource_observations_id_seq from public,anon,authenticated;
grant all on public.resource_observations to service_role;
grant all on sequence public.resource_observations_id_seq to service_role;
-- All access is through authenticated server policies. No user-JWT observation ingestion.
