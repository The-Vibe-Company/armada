-- A refused enrolment retires the logical resume independently of the host job ACK.
alter table public.docker_resume_claims add column protocol_refused boolean not null default false;
