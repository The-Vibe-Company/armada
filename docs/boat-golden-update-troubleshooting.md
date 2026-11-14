# Boat golden rebuild admission

A rebuild uses the existing golden's backend slot, even at capacity one. Do not
create a second golden as a workaround. Both the dashboard rebuild and
`armada golden update` submit the same durable admission path.

## Read-only diagnosis

Run with the affected user's Armada login and organization:

```sh
armada golden capabilities --provider boat
armada golden list --provider boat --org <org-id> --json
armada golden build-status --idempotency-key <printed-admission-key> --org <org-id>
armada golden build-status <job-id>
```

“No such build” for an admission key means no visible durable admission exists.
It is not evidence of a checkout failure. A busy rebuild now includes the
blocking durable job ID and its creation time. A reservation without a durable
job is reported separately. A missing binding means the golden does not match
the connected backend account; restore the original connection rather than
creating or adopting a slot implicitly.

After admission, status reports the build phase. Repository authorization uses
the caller's GitHub connection, not permission elevation through the GitHub App.
Grant that caller read access to every requested repository. App installation
coverage is also required where installation tokens are used for checkout.
Neither capacity nor a missing binding proves a GitHub authorization problem.

## Recovery limits

Durable running jobs have fenced leases and deadlines. Expired jobs transition
to recovery; reservations are released only after safe builder reconciliation.
A timeout must not simply clear a reservation while a provider operation could
still publish a snapshot. There is currently no owner-facing cancellation or
orphan-reservation repair command. An administrator must investigate these
states; this change does not add an unsafe automatic unlock.

After the actual blocker is resolved and the fix is released, retry with the
**complete desired repository list**, not just the new repository:

```sh
armada golden update two-repos-prod-test --provider boat --org <org-id> --repo <existing-owner/repo-1> --repo <existing-owner/repo-2> --repo <other-existing-repo> --repo <new-owner/repo>
```

Repeat `--repo` for every existing repository; preserve required initialization
commands using `--init`, or use the complete desired `--config` instead.
No production rebuild was executed as part of this diagnosis.
