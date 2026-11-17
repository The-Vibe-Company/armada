-- A cancelled request must not reserve the stopped lifecycle forever. Each
-- replacement still requires its own durable acknowledgement from the host.
alter table public.docker_resume_claims
  drop constraint docker_resume_claims_sandbox_id_lifecycle_generation_key;
