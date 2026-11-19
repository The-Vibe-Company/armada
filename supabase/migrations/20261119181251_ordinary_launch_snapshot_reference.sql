create table public.sandbox_source_snapshots (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  snapshot_id text not null
);

create index sandbox_source_snapshots_snapshot_id on public.sandbox_source_snapshots (snapshot_id);

alter table public.sandbox_source_snapshots enable row level security;
revoke all on public.sandbox_source_snapshots from public, anon, authenticated;
grant select, insert on public.sandbox_source_snapshots to service_role;
