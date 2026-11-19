-- Before protocol recording, every issued runtime token used v1. The fixed
-- default also covers the old v1 writer during the first deployment overlap.
alter table public.runtime_enrolments
  add column runtime_protocol_version integer not null default 1
    check (runtime_protocol_version > 0);
