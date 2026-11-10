-- Snapshot-bound public metadata, written only by the server build publisher.
alter table public.goldens add column build_warnings text[] not null default '{}'
  check (build_warnings <@ array['skillpack_download_unavailable','skillpack_user_local_only']::text[]);
grant select (build_warnings) on public.goldens to authenticated;
alter table public.golden_build_jobs add column build_warnings text[] not null default '{}'
  check (build_warnings <@ array['skillpack_download_unavailable','skillpack_user_local_only']::text[]);
alter table public.golden_build_jobs add column failure_reason text
  check (failure_reason is null or failure_reason='skillpack_integrity_failed');
