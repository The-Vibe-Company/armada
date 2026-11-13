-- Historical snapshots have no trustworthy release version: do not invent one.
alter table public.docker_snapshots add column built_on_version text
  check (built_on_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$');

create function public.immutable_docker_snapshot_base() returns trigger language plpgsql set search_path=public as $$
begin
  if new.base_image is distinct from old.base_image or new.built_on_version is distinct from old.built_on_version then
    raise exception 'Snapshot base is immutable';
  end if;
  return new;
end;$$;
create trigger immutable_docker_snapshot_base before update on public.docker_snapshots
  for each row execute function public.immutable_docker_snapshot_base();
revoke all on function public.immutable_docker_snapshot_base() from public,anon,authenticated;
