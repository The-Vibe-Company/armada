-- Physical identities are supplied only by trusted server launches, for every provider.
-- Removing a table grant does not remove column grants, so revoke both.
revoke insert on public.sandboxes from authenticated;
do $$
declare
  columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns
  from pg_attribute
  where attrelid = 'public.sandboxes'::regclass and attnum > 0 and not attisdropped;
  execute format('revoke insert (%s) on public.sandboxes from authenticated', columns);
end;
$$;

drop policy sandboxes_insert on public.sandboxes;
drop policy sandboxes_modal_server_insert on public.sandboxes;

-- Existing rows, selection/update policies and service-role registration are unchanged.
