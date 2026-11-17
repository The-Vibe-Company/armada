-- Server-recorded cancellation of queued host work that can no longer be dispatched.
-- Cancellation is server intent, never machine evidence: it does not prove a
-- container stopped, so it never populates sandbox stopped_at/deleted_at.
alter table public.docker_host_jobs add column cancelled_at timestamptz;
alter table public.docker_host_jobs add constraint docker_host_jobs_cancellation_check
  check (cancelled_at is null or completed_at is not null);
comment on column public.docker_host_jobs.cancelled_at is
  'Set when the server retired queued work it could no longer dispatch; a later host fact still wins.';
-- A queued snapshot build retired by host revoke/retirement is a new closed public diagnostic.
alter table public.docker_snapshots drop constraint docker_snapshots_failure_reason_check;
alter table public.docker_snapshots add constraint docker_snapshots_failure_reason_check
  check (failure_reason in (
    'Snapshot build expired before an image was published.',
    'Snapshot build authorization is no longer valid.',
    'Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.',
    'Host disk free space is below the required 10 GB floor or unavailable; free space and retry.',
    'Host retired before snapshot publication.'
  ));
