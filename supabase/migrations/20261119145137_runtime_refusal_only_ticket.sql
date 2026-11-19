-- A failed Docker resume ACK may retain the expiring hash for protocol refusal
-- while revoking the configuration and runtime credentials.
alter table public.runtime_enrolments
  drop constraint runtime_enrolments_check,
  add constraint runtime_enrolments_ticket_shape check (
    (enrolment_hash is null and enrolment_expires_at is null and configuration_enc is null)
    or (enrolment_hash is not null and enrolment_expires_at is not null)
  );
