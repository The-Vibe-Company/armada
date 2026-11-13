-- Host-local immutable snapshots. Values/credentials never enter public snapshot metadata.
create table public.docker_snapshots (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  owner_id uuid not null references auth.users(id),
  host_id uuid not null references public.docker_hosts(id),
  installation_id uuid not null,
  name text not null check (name ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  visibility public.visibility not null,
  config jsonb not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  actor_epoch bigint not null,
  issuer_epoch bigint not null,
  generation uuid not null,
  base_image text not null,
  build_expires_at timestamptz not null,
  status text not null default 'building' check (status in ('building','ready','failed')),
  image_id text check (image_id ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check ((status='ready') = (image_id is not null))
);
alter table public.docker_snapshots enable row level security;
create policy docker_snapshots_read on public.docker_snapshots for select to authenticated using (
  exists(select 1 from public.members m where m.org_id=docker_snapshots.org_id and m.user_id=auth.uid())
  and (visibility='org' or owner_id=auth.uid())
);
revoke all on public.docker_snapshots from public,anon,authenticated;
grant select on public.docker_snapshots to authenticated;
grant all on public.docker_snapshots to service_role;
alter table public.sandboxes add column docker_snapshot_id uuid references public.docker_snapshots(id);
revoke all(docker_snapshot_id) on public.sandboxes from public,anon,authenticated;
grant select(docker_snapshot_id) on public.sandboxes to authenticated;
alter table public.docker_host_jobs add column snapshot_id uuid references public.docker_snapshots(id),
  add column result_image_id text check(result_image_id ~ '^sha256:[0-9a-f]{64}$');
alter table public.docker_host_jobs drop constraint docker_host_jobs_bound_check;
alter table public.docker_host_jobs add constraint docker_host_jobs_bound_check check (
  (snapshot_id is null and bound_sandbox_id is null and bound_actor_id is null and bound_actor_epoch is null and bound_operation is null)
  or (snapshot_id is null and bound_sandbox_id is not null and bound_actor_id is not null and bound_actor_epoch is not null
    and bound_actor_epoch>=0 and bound_operation in ('create','bootstrap','resume','stop','delete'))
  or (snapshot_id is not null and bound_sandbox_id is null and bound_actor_id is not null and bound_actor_epoch is not null
    and bound_actor_epoch>=0 and bound_operation='buildSnapshot')
);
revoke all(snapshot_id) on public.docker_host_jobs from public,anon,authenticated;

alter table public.sandboxes add constraint sandboxes_snapshot_provider_check check(docker_snapshot_id is null or provider='docker');
create function public.immutable_docker_snapshot_source() returns trigger language plpgsql set search_path=public as $$
begin
  if new.docker_snapshot_id is distinct from old.docker_snapshot_id then raise exception 'Snapshot source is immutable';end if;
  return new;
end;$$;
create trigger immutable_docker_snapshot_source before update on public.sandboxes for each row execute function public.immutable_docker_snapshot_source();
revoke all on function public.immutable_docker_snapshot_source() from public,anon,authenticated;
