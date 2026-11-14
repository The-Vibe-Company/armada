-- Routine lists include enabled and paused rows. The original routines_org
-- index covers paused rows only, and routines_due serves scheduler due-time
-- scans, not org/name list reads. Keep both and add the active list path.
create index routines_active_org_name on public.routines(org_id,name,id)
where status <> 'deleted';
