-- Self completion uses the existing durable stop/reconciliation lane.
alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason in ('expired','idle_paused','agent_finished'))
);
comment on column public.sandboxes.status_reason is
  'Failure diagnostic, expired lifetime stop, idle_paused checkpointed stop, or agent_finished explicit self completion.';
