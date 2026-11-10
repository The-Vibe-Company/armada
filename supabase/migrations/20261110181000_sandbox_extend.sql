-- Extension is a distinct delegated cost authority, never implied by read access.
alter table public.orchestrator_delegations drop constraint orchestrator_delegations_scopes_check;
alter table public.orchestrator_delegations add constraint orchestrator_delegations_scopes_check
  check(scopes <@ array['worker:launch','worker:read','worker:message','worker:stop','worker:extend']::text[]);
alter table public.orchestrator_child_operations drop constraint orchestrator_child_operations_action_check;
alter table public.orchestrator_child_operations add constraint orchestrator_child_operations_action_check
  check(action in ('launch','message','stop','extend'));
alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason='expired')
);
comment on column public.sandboxes.status_reason is 'Failure diagnostic, or expired for a lifetime stop.';
