-- An interrupted uninstall is a state refusal, not lost build authorization: keep its actionable reason.
-- The closed set mirrors DOCKER_SNAPSHOT_FAILURE_MESSAGES in @armada/core; every writer's reason must be
-- listed here, including the pre-existing retirement and disk-floor completions.
alter table public.docker_snapshots drop constraint docker_snapshots_failure_reason_check;
alter table public.docker_snapshots add constraint docker_snapshots_failure_reason_check
  check (failure_reason in (
    'Snapshot build expired before an image was published.',
    'Snapshot build authorization is no longer valid.',
    'Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.',
    'Host retired before snapshot publication.',
    'Host disk free space is below the required 10 GB floor or unavailable; free space and retry.',
    'This host is draining for uninstall. Finish or retry the uninstall on the machine; it can take new work again after the uninstall completes or an abandoned drain expires.'
  ));
