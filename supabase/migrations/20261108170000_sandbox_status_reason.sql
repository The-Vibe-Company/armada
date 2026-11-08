-- Why a sandbox failed: a usage limit, an expired login, or a launch error (#463).
-- Never edit a migration that has been applied.

alter table public.sandboxes
  add column status_reason text;

-- A reason belongs to a failure: any other status has none.
alter table public.sandboxes
  add constraint sandboxes_status_reason_chk
  check (status_reason is null or (status = 'failed' and char_length(status_reason) between 1 and 2000));

comment on column public.sandboxes.status_reason is
  'Why the sandbox failed, redacted of credentials. Null unless status is failed.';

-- Column grants add to the update list from the RLS migration.
grant update (status_reason) on public.sandboxes to authenticated;
