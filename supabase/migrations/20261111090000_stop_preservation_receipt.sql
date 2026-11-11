-- Durable successful preservation for the current stop request, including clean results.
-- Server-written metadata; existing RLS-scoped sandbox reads remain compatible.
alter table public.sandboxes add column stop_generation bigint not null default 0 check (stop_generation >= 0),
  add column preservation_stop_generation bigint;
comment on column public.sandboxes.preservation_stop_generation is
  'Successful capture/check for stop_generation. Never infer completion from note text.';
-- Existing table-level INSERT covers future columns. Keep all existing insert
-- permissions, but do not let a user forge the server-written completion marker.
revoke insert on public.sandboxes from authenticated;
do $$
declare columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns
  from pg_attribute
  where attrelid='public.sandboxes'::regclass and attnum>0 and not attisdropped
    and attname not in ('stop_generation','preservation_stop_generation');
  execute 'grant insert (' || columns || ') on public.sandboxes to authenticated';
end $$;
