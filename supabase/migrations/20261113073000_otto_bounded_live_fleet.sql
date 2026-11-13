-- Historical smoke-test fleets must not affect the cost of an Otto live read.
create index sandboxes_otto_live on public.sandboxes(org_id,id)
 where deleted_at is null and status not in ('stopped','deleted','failed');
-- Bound the journal walk even when a live Modal sandbox has many non-agent events.
create index modal_events_otto_agent on public.modal_events(scope,sandbox_id,cursor desc)
 where event->>'kind' in ('prompt','message');
