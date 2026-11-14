-- OpenCode reuses the same immutable Modal dial-out selection and epoch fences.
alter table public.sandboxes drop constraint sandboxes_runtime_transport_target;
alter table public.sandboxes add constraint sandboxes_runtime_transport_target check (
  runtime_transport is null or (
    runtime_transport = 'dialout' and provider = 'modal'
    and harness in ('codex', 'claude', 'opencode') and not boat_runtime
  )
);
