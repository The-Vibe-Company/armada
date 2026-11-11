-- Durable successful preservation for the current stop request, including clean results.
-- Server-written metadata; existing RLS-scoped sandbox reads remain compatible.
alter table public.sandboxes add column stop_generation bigint not null default 0 check (stop_generation >= 0),
  add column preservation_stop_generation bigint;
comment on column public.sandboxes.preservation_stop_generation is
  'Successful capture/check for stop_generation. Never infer completion from note text.';
-- Server-owned sandbox registration already revokes user INSERT/UPDATE access
-- to these fields. Do not re-grant earlier table privileges here.
