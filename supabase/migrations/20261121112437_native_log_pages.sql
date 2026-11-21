begin;

create schema armada_logs;
revoke all on schema armada_logs from public, anon, authenticated;

create table armada_logs.native_log_pages (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  provider_sandbox_id text not null,
  slot smallint not null check (slot between 0 and 7),
  request_hash text not null,
  observed_at timestamptz not null,
  page_enc bytea not null check (octet_length(page_enc) <= 1310748),
  primary key (sandbox_id, slot)
);

alter table armada_logs.native_log_pages enable row level security;
revoke all on armada_logs.native_log_pages from public, anon, authenticated;

commit;
