-- An interrupted uninstall is a state refusal, not lost build authorization: keep its actionable reason.
alter table public.docker_snapshots drop constraint docker_snapshots_failure_reason_check;
alter table public.docker_snapshots add constraint docker_snapshots_failure_reason_check
  check (failure_reason in (
    'Snapshot build expired before an image was published.',
    'Snapshot build authorization is no longer valid.',
    'Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.',
    'This host is draining for uninstall. Finish or retry the uninstall on the machine; it can take new work again after the uninstall completes or an abandoned drain expires.'
  ));
