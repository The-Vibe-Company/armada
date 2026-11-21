begin;

create table public.sandbox_native_preservation_receipts (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  generation bigint not null,
  stop_generation bigint not null
);

alter table public.sandbox_native_preservation_receipts enable row level security;
revoke all on public.sandbox_native_preservation_receipts from public, anon, authenticated;
grant select, insert, update on public.sandbox_native_preservation_receipts to service_role;

commit;
