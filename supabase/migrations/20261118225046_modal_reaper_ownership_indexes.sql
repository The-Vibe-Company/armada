-- Ownership reconciliation also checks for conflicts across scopes.
-- Index both lookup keys without requiring either one to be unique.
create index modal_machines_reaper_logical_idx on public.modal_machines (id);
create index modal_machines_reaper_physical_idx on public.modal_machines ((record->>'physicalId'));
