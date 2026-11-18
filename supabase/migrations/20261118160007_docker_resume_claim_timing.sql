-- Leave older claims undated. New requests and their first positive acknowledgement
-- supply the timing of the claim that actually opened the resume activation.
alter table public.docker_resume_claims
  add column created_at timestamptz,
  add column claimed_at timestamptz;
alter table public.docker_resume_claims alter column created_at set default clock_timestamp();
