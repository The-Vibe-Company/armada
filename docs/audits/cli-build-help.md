# Snapshot build discovery (#979)

Help-only follow-up to the ranked nested-help finding.
The exact invocations below now work without signing in or reading local files:

- `armada snapshot build-find --help`: find an active build by snapshot name.
- `armada snapshot build-status --help`: inspect a job or recover admission
  with a saved idempotency key and organization.
- `armada snapshot build-cancel --help`: cancel your queued, never-started job.

Each also accepts `-h` and the legacy `golden` command spelling.
Adding a name, job ID or other argument leaves operation parsing unchanged.

Examples:

```sh
armada snapshot build-find starter --provider modal --json
armada snapshot build-status --idempotency-key saved-build-key --org my-team
armada snapshot build-cancel build-id --org my-team
```

These are discovery changes only: no job is created, inspected or cancelled by
help. Authenticated behavior, output schemas and permissions are unchanged.
No live provider/TTY audit is claimed or needed for this help-only slice under
the issue's amendment. The run.ts regression coverage forbids help I/O.
