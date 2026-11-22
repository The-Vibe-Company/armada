begin;

-- Private lookup evidence for a pending native deletion.
create table public.native_drain_delete_operations (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  provider public.sandbox_provider not null,
  placement text not null,
  operation_id text not null
);

alter table public.native_drain_delete_operations enable row level security;
revoke all on public.native_drain_delete_operations from public, anon, authenticated, service_role;
grant select, insert, delete on public.native_drain_delete_operations to service_role;

commit;
