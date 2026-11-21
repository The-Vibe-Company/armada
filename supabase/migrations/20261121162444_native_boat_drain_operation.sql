begin;

-- Service-only lookup key for the provider's asynchronous deletion operation.
alter table public.sandboxes add column native_boat_drain_operation_id text;

commit;
