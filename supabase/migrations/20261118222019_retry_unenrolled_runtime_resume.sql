-- A resume abandoned before enrolment keeps its request ID as a replay fence
-- without permanently reserving the source checkpoint against other requests.
create unique index runtime_resumes_source_epoch_reserved
  on public.runtime_resumes(sandbox_id, source_epoch) where phase <> 'abandoned';

alter table public.runtime_resumes
  drop constraint runtime_resumes_phase_check,
  drop constraint runtime_resumes_sandbox_id_source_epoch_key,
  add constraint runtime_resumes_phase_check
    check (phase in ('dispatched', 'complete', 'failed', 'abandoned'));
