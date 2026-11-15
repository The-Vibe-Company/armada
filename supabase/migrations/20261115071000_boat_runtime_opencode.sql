-- OpenCode uses the existing shared runtime, never a Boat-native harness alias.
alter table public.sandboxes drop constraint sandboxes_boat_runtime_target;
alter table public.sandboxes add constraint sandboxes_boat_runtime_target check (
  not boat_runtime or (provider = 'boat' and harness in ('codex', 'claude', 'opencode'))
);
