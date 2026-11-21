begin;

-- Private lookup evidence for a pending native Boat deletion.
create table public.native_boat_drain_operations (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  placement text not null,
  operation_id text not null
);

alter table public.native_boat_drain_operations enable row level security;
revoke all on public.native_boat_drain_operations from public, anon, authenticated, service_role;
grant select, insert, delete on public.native_boat_drain_operations to service_role;

commit;
