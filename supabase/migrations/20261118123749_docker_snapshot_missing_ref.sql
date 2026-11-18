-- Persist only a checked repository index from the host. The API builds the
-- diagnostic from the snapshot config without storing raw checkout output.
alter table public.docker_snapshots add column missing_ref_index smallint
  check (missing_ref_index is null or (missing_ref_index between 1 and 16 and status = 'failed'));
