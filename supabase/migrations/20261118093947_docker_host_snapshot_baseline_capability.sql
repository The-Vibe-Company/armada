-- Source deployments can share a version with an older tagged daemon.
alter table public.docker_hosts
  add column snapshot_baseline_version integer check (snapshot_baseline_version > 0);

-- Only jobs admitted by a baseline-aware server require a verified receipt.
alter table public.docker_snapshots
  add column required_baseline_version integer check (required_baseline_version > 0);

alter table public.docker_snapshots drop constraint docker_snapshots_failure_reason_check;
alter table public.docker_snapshots add constraint docker_snapshots_failure_reason_check
  check (failure_reason in (
    'Snapshot build expired before an image was published.',
    'Snapshot build authorization is no longer valid.',
    'Snapshot image build failed. Check registry access, repository access, init commands and the secret scan; build output is suppressed to protect secrets.',
    'Host disk free space is below the required 10 GB floor or unavailable; free space and retry.',
    'Host retired before snapshot publication.',
    'This host is draining for uninstall. Finish or retry the uninstall on the machine; it takes new work again only after the uninstall completes.',
    'The Docker host did not verify the developer baseline. Update the host daemon and retry the build.'
  ));
