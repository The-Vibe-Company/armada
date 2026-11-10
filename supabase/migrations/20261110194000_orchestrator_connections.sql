-- User MCP selection changes are ordinary owner-private, revision-fenced receipts.
alter table public.orchestrator_operations drop constraint orchestrator_operations_action_check;
alter table public.orchestrator_operations add constraint orchestrator_operations_action_check
 check(action in ('create','message','steer','stop','resume','connections_add','connections_remove'));
