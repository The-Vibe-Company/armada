begin;

alter table public.sandboxes
  add column native_drain_pending boolean not null default false;

commit;
