alter table public.sandboxes
  add column pull_requests jsonb not null default '[]'::jsonb,
  add column pull_request_reports jsonb not null default '{}'::jsonb,
  add column pull_request_check_after timestamptz not null default now(),
  add column pull_request_merge_proof jsonb,
  add column stop_when_work_merged boolean not null default true;

create index sandboxes_pull_request_check_due
  on public.sandboxes(pull_request_check_after)
  where status in ('ready', 'running') and stop_requested_at is null;
