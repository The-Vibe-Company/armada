# Sandbox list discovery (#979)

List now has focused long/short help before login/I/O instead of the broad root
command list. Exact boundaries only; filters and option values keep their parsers.

```sh
armada list --owner me --page 1 --limit 25 --json
armada list --org ORG_UUID --page 2 --page-info
armada list --agent codex --status ready --json
```

List reads one page, not all results. Page accepts 1–1000000 and limit 1–200;
default page size is 25. Agent/harness are aliases that cannot combine.
Golden filters by snapshot UUID; owner accepts a user UUID or me.
Status accepts starting, ready, running, stopping, stopped, failed or deleted.
Deleted sandboxes are excluded by default; request --status deleted explicitly.

Human output is tabular. JSON preserves the sandboxes wrapper; page-info
returns the full response including exact totals, always as JSON.
Explicit organization overrides saved selection. Reuse returned IDs with
other sandbox commands. Server visibility and authorization remain unchanged.

Offline run.ts audit: four no-session/fake-token long/short-help probes show
broad root help before and focused guidance after, zero requests.
No sandbox lists are fetched. This help-only slice uses the issue's audit
exemption and changes no filters, pagination, permissions or output schemas;
no staging/provider/TTY evidence is claimed.
