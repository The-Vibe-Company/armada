-- Bound write contention while the migration builds both indexes.
set local lock_timeout = '2s';
set local statement_timeout = '5s';

-- Ownership reconciliation also checks for conflicts across scopes.
-- Index both lookup keys without requiring either one to be unique.
create index modal_machines_reaper_logical_idx on public.modal_machines (id);
create index modal_machines_reaper_physical_idx on public.modal_machines ((record->>'physicalId'));
