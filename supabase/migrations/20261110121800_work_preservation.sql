-- Public receipt is metadata only. Recovery payload is service-role only.
alter table public.sandboxes add column preservation_note text;
grant select (preservation_note) on public.sandboxes to authenticated;
create table public.sandbox_work_recovery (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  archive_enc bytea not null check (octet_length(archive_enc) <= 3000000),
  created_at timestamptz not null default now()
);
alter table public.sandbox_work_recovery enable row level security;
revoke all on public.sandbox_work_recovery from anon, authenticated;
grant all on public.sandbox_work_recovery to service_role;
