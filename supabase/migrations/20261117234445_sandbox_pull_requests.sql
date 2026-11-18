alter table public.sandboxes
  add column pull_request_source jsonb,
  add column pull_request_scan jsonb,
  add column pull_requests jsonb not null default '[]'::jsonb,
  add column pull_request_reports jsonb not null default '{}'::jsonb,
  add column pull_request_check_after timestamptz not null default now(),
  add column pull_request_merge_proof jsonb,
  add column stop_when_work_merged boolean not null default true;

create index sandboxes_pull_request_check_due
  on public.sandboxes(pull_request_check_after)
  where status in ('ready', 'running') and stop_requested_at is null;

alter table public.sandboxes drop constraint sandboxes_status_reason_chk;
alter table public.sandboxes add constraint sandboxes_status_reason_chk check (
  status_reason is null
  or (status='failed' and char_length(status_reason) between 1 and 2000)
  or (status in ('stopping','stopped') and status_reason in ('expired','idle_paused','agent_finished','work_merged'))
  or (status='deleted' and status_reason in ('retention_elapsed','disk_pressure'))
);
