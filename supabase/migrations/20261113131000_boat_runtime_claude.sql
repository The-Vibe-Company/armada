-- Reuse the same immutable runtime lane for the existing Claude driver.
-- No change to native sessions or other providers.
alter table public.sandboxes drop constraint sandboxes_boat_runtime_target;
alter table public.sandboxes add constraint sandboxes_boat_runtime_target check (
  not boat_runtime or (provider = 'boat' and harness in ('codex', 'claude'))
);
