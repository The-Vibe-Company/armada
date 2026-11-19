# Boat snapshot rebuild admission

A rebuild uses the existing snapshot's backend slot, even at capacity one. Do not
create a second snapshot as a workaround. Both the dashboard rebuild and
`armada snapshot update` submit the same durable admission path.

## Read-only diagnosis

Use the affected user's Armada login. Replace `ORG_UUID` with the organization's
UUID and `ADMISSION_KEY` and `JOB_UUID` with the key and job UUID printed by the CLI.

```sh
armada snapshot capabilities --provider boat --org ORG_UUID
armada snapshot list --provider boat --org ORG_UUID --json
armada snapshot build-status --idempotency-key ADMISSION_KEY --org ORG_UUID
armada snapshot build-status JOB_UUID
```

“No such build” for an admission key means no visible durable admission exists.
It is not evidence of a checkout failure. A busy rebuild now includes the
blocking durable job ID and its creation time. A reservation without a durable
job is reported separately. A missing binding means the snapshot does not match
the connected backend account; restore the original connection rather than
creating or adopting a slot implicitly.

Requested repository access is checked before admission, so a missing GitHub grant
refuses the form immediately without reserving capacity. Execution rechecks access
in case it was revoked while queued. After admission, status retains the build
phase and a curated reason (for example, clone failure, init command index/exit
code, or secret scan rejection), never raw command output.

Repository authorization uses
the caller's GitHub connection, not permission elevation through the GitHub App.
Grant that caller read access to every requested repository. App installation
coverage is also required where installation tokens are used for checkout.
Neither capacity nor a missing binding proves a GitHub authorization problem.

## Find active work when the receipt was lost

A rebuild's current job can be found without the original admission key or URL. Replace `SNAPSHOT_NAME` with its name.

    armada snapshot build-find "SNAPSHOT_NAME" --provider boat --org ORG_UUID

On the Snapshots page, open the existing snapshot's Edit and rebuild form and
choose Find active build. The latest visible queued, running or recovery-required
attempt enters the existing status controls; a requester-owned queued build can
then be cancelled safely. Finding a job only reads metadata: it never submits,
restarts, cancels, renews a lease or contacts the provider. A same-name snapshot
on another provider needs the explicit provider selection, just like update.

No visible active build is **not** evidence that capacity is free: a hidden job,
retained reservation or orphan record may still need administrator investigation.
Private build history remains private even if the snapshot is later shared. This
lookup does not grant anyone permission to cancel another requester's work.

## Recovery limits

Queued admissions expire after one hour without starting a builder. On the next
worker tick, the job becomes failed with a queue-expiry explanation and its own
reservation is released atomically; a rebuild retains its existing snapshot binding.
A queued row with execution evidence is held for recovery instead of being unlocked.
This needs the worker to be running; it is not a database timer.

Durable running jobs have fenced leases and deadlines. Expired jobs transition
to recovery. If the durable phase is still authorization, the attempt has a fence,
and both builder and snapshot references are absent, recovery can release that
exact reservation without contacting a provider. The row is rechecked under lock,
marked failed with a safe reason, and the original snapshot binding is retained.
A late authorization callback cannot enter the builder phase after recovery owns
the row. This runs on the worker's recovery tick, not on a database timer.

A missing builder ID alone is not proof of safety: builder-phase or later attempts
still require their existing provider reconciliation and retain uncertain capacity.
A timeout must not simply clear a reservation while a provider operation could
still publish a snapshot. Owners can cancel a queued, never-started build using Cancel queued build beside
its tracked status in the dashboard, or:

    armada snapshot build-cancel JOB_UUID --org ORG_UUID

Cancellation is idempotent and only releases that admission's reservation. A
rebuild keeps its existing snapshot binding and snapshot. If a worker has already
claimed the job, cancellation refuses with a conflict and retains capacity;
check status and ask an administrator to reconcile running or uncertain work.
There is still no owner-facing running-build cancellation or orphan-reservation
repair command. An administrator must investigate these
states; this change does not add an unsafe automatic unlock.

For the full CLI refusal/version-skew inventory, see
[Snapshot update CLI refusals](golden-update-cli-refusals.md).

To append a repository, substitute your snapshot name and the new repository URL.

    armada snapshot update two-repos-prod-test --provider boat --org ORG_UUID --add-repo https://github.com/new-owner/repo.git

For intentional replacement with --repo or --config, supply the
**complete desired repository list**, not just the new repository:

```sh
armada snapshot update two-repos-prod-test --provider boat --org ORG_UUID --replace --repo https://github.com/current-owner/repo-1.git --repo https://github.com/current-owner/repo-2.git --repo https://github.com/new-owner/repo.git
```

Replace the example name and URLs with your snapshot name and repository URLs.
Repeat `--repo` for every existing repository you want to keep; preserve required initialization
commands using `--init`, or use the complete desired `--config` instead.
No production rebuild was executed as part of this diagnosis.
