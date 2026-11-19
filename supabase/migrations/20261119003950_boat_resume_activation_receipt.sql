-- A confirmed Boat activation can require retained cleanup before a runtime ticket exists.
alter table public.runtime_resumes add column activated_at timestamptz;
