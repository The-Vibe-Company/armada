-- Extend the immutable staging opt-in to the shared enrolled Claude driver.
-- Native Modal launches and the transport immutability trigger are unchanged.
alter table public.sandboxes drop constraint sandboxes_runtime_transport_target;
alter table public.sandboxes add constraint sandboxes_runtime_transport_target check (
  runtime_transport is null or (
    runtime_transport = 'dialout' and provider = 'modal'
    and harness in ('codex', 'claude') and not boat_runtime
  )
);
