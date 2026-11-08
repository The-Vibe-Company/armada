-- The sandbox a golden is built in. boat_snapshot_id stays null until snapshot.
-- Connect and snapshot read this id; the human name is not a boat name.
-- Never edit a migration that has been applied.

alter table public.goldens
  add column boat_sandbox_id text;

alter table public.goldens
  add constraint goldens_boat_sandbox_id_chk
  check (boat_sandbox_id is null or char_length(boat_sandbox_id) > 0);

create unique index goldens_boat_sandbox_id_key on public.goldens (boat_sandbox_id)
  where boat_sandbox_id is not null;

comment on column public.goldens.boat_sandbox_id is
  'Provider id of the sandbox the golden is built in. Not a secret. Null until create starts it.';

-- Column grants add to the update list from the RLS migration.
grant update (boat_sandbox_id) on public.goldens to authenticated;
