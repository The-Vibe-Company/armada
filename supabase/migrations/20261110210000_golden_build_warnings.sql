-- Snapshot-bound public metadata, written only by the server build publisher.
alter table public.goldens add column build_warnings text[] not null default '{}'
  check (build_warnings <@ array['skillpack_download_unavailable','skillpack_user_local_only']::text[]);
grant select (build_warnings) on public.goldens to authenticated;
alter table public.golden_build_jobs add column build_warnings text[] not null default '{}'
  check (build_warnings <@ array['skillpack_download_unavailable','skillpack_user_local_only']::text[]);
alter table public.golden_build_jobs add column failure_reason text
  check (failure_reason is null or failure_reason='skillpack_integrity_failed');

-- A table-level INSERT grant otherwise covers every future column. Preserve
-- existing insert access column-by-column, excluding the server-owned outcome.
revoke insert on public.goldens from authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
  from pg_attribute where attrelid='public.goldens'::regclass
    and attnum>0 and not attisdropped and attname<>'build_warnings';
  execute format('grant insert (%s) on public.goldens to authenticated', cols);
end $$;
