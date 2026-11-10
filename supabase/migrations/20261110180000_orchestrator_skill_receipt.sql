-- Public package provenance only. Existing runtime RLS/grants still apply.
alter table public.orchestrator_runtime add column skill_receipt jsonb;
