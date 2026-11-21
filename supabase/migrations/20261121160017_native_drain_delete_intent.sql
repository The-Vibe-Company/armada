begin;

alter table public.sandboxes
  add column native_drain_pending boolean not null default false;

create policy sandboxes_native_drain_update on public.sandboxes
  as restrictive for update to authenticated
  using (not native_drain_pending)
  with check (not native_drain_pending);

commit;
