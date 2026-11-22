-- Evidence of the command deadline delivered in this Modal activation's ticket.
-- A previous server may issue a new ticket during overlap without updating this
-- evidence. The epoch comparison prevents it from authorizing an extension.
alter table public.runtime_enrolments
  add column command_grant_epoch bigint,
  add column command_grant_expires_at timestamptz;
