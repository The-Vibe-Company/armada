-- Keep automatic workspace deletion visible after its physical resources are gone.
alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason in ('expired','idle_paused','agent_finished'))
  or (status='deleted' and status_reason in ('retention_elapsed','disk_pressure'))
);
