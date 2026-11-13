-- Completed host-local snapshot catalog. Capture/restore is a separate protocol;
-- no caller may register a snapshot or choose its official-image provenance.
create table public.docker_snapshots (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  host_id uuid not null references public.docker_hosts(id),
  installation_id uuid not null,
  name text not null check (length(name) between 1 and 80 and name !~ '[[:cntrl:]]' and name = btrim(name)),
  official_image_version text not null check (
    length(official_image_version) <= 80 and official_image_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'
  ),
  official_image text not null check (
    official_image ~ '^ghcr\.io/the-vibe-company/armada-sandbox@sha256:[a-f0-9]{64}$'
  ),
  created_at timestamptz not null default now()
);
create index docker_snapshots_owner_host on public.docker_snapshots(org_id, owner_id, host_id, created_at, id);

create function public.guard_docker_snapshot_provenance() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or new.org_id is distinct from old.org_id or
    new.owner_id is distinct from old.owner_id or new.host_id is distinct from old.host_id or
    new.installation_id is distinct from old.installation_id or
    new.official_image_version is distinct from old.official_image_version or
    new.official_image is distinct from old.official_image or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Docker snapshot provenance is immutable';
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.docker_hosts h where h.id = new.host_id and h.org_id = new.org_id
      and h.installation_id = new.installation_id and h.revoked_at is null
  ) then
    raise exception 'Docker snapshot host binding is invalid';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_docker_snapshot_provenance() from public, anon, authenticated;
create trigger docker_snapshot_provenance before insert or update on public.docker_snapshots
for each row execute function public.guard_docker_snapshot_provenance();

alter table public.docker_snapshots enable row level security;
revoke all on public.docker_snapshots from public, anon, authenticated;
grant all on public.docker_snapshots to service_role;
grant select on public.docker_snapshots to authenticated;
create policy docker_snapshots_private_read on public.docker_snapshots for select to authenticated
using (owner_id = auth.uid() and exists (
  select 1 from public.members m where m.org_id = docker_snapshots.org_id and m.user_id = auth.uid()
));
