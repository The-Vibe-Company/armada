alter table public.goldens add column baseline_version integer check (baseline_version > 0);
grant select (baseline_version) on public.goldens to authenticated;

-- Mutable snapshot writers, including older servers and user-JWT Boat writers,
-- must invalidate verification. The build publisher stamps its receipt in the
-- same transaction after setting the verified snapshot pointer.
create function public.clear_golden_snapshot_baseline() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.baseline_version := null;
  return new;
end;
$$;
create trigger clear_golden_snapshot_baseline
  before update of provider_snapshot_id, boat_snapshot_id on public.goldens
  for each row execute function public.clear_golden_snapshot_baseline();

alter table public.docker_snapshots add column baseline_version integer
  check (baseline_version is null or (baseline_version > 0 and status = 'ready'));
alter table public.docker_snapshots add column baseline_failure_tool text
  check (baseline_failure_tool is null or (status = 'failed' and length(baseline_failure_tool) between 1 and 32));
