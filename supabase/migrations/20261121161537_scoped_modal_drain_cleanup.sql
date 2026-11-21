begin;

-- The service-only scoped parent records the exact placement cleaned before
-- provider deletion. A later drain owner can replay that placement's journal.
alter table public.armada_access_parents
  add column modal_drain_cleaned_placement text;

commit;
