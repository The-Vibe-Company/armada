alter table public.sandboxes add column source_snapshot_id text;

create index sandboxes_live_source_snapshot
  on public.sandboxes (provider, source_snapshot_id)
  where source_snapshot_id is not null
    and status <> 'deleted' and (status <> 'failed' or stopped_at is null);
