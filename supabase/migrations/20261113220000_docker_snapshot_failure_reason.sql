-- Safe, bounded diagnostics only; never persist build output or init commands.
alter table public.docker_snapshots add column failure_reason text
  check (failure_reason in (
    'Snapshot build expired before an image was published.',
    'Snapshot build authorization is no longer valid.',
    'Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.'
  ));
