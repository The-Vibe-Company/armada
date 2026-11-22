begin;

create table public.native_drain_unclaimed_dispatches (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade
);

alter table public.native_drain_unclaimed_dispatches enable row level security;
revoke all on public.native_drain_unclaimed_dispatches from public, anon, authenticated, service_role;
grant select, insert, delete on public.native_drain_unclaimed_dispatches to service_role;

commit;
