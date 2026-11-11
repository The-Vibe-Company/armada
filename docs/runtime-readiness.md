# Database runtime readiness (#972)

`/healthz` keeps its unauthenticated success shape (`ok: true`, `version`) but the
production server now checks its existing serving SQL pool with a read-only
`select 1`. Failure or a two-second observation deadline returns HTTP 503,
`ok: false`, the version and the closed reason `database_unavailable`.
Responses remain `Cache-Control: no-store`; unavailable responses carry
`Retry-After: 5`. Driver messages, connection strings and credentials never enter
the response. There are no automatic mutation retries.

The checker caches either result for one second and shares one in-flight query
across callers. A two-second timeout bounds the HTTP observation, **not** the raw
SQL operation: until the driver settles, further probes reuse the unavailable
result rather than accumulate queries or open another pool. Its late success
cannot publish healthy status; after cache expiry a fresh query must succeed.
An indefinitely stuck driver therefore remains unavailable instead of reporting
false recovery. This adds at most one readiness query at a time, using the same
connection admission as application queries (including pool saturation).

This is not proof that writes, migrations, Supabase Auth, providers or model APIs
work. It does not test external dependencies on every unauthenticated poll. The
existing startup admission retry remains unchanged. A deployment readiness check
can now fail honestly if the database becomes inaccessible after initialization.
Railway healthchecks gate deployment activation; do not assume they continuously
restart a running deployment. The existing public production-health workflow
also checks `/healthz` and will now observe this failure. No workflow changes.

## Operator staging check: `database-runtime-readiness`

Run only in a disposable, authorized staging environment; this agent does not
modify production or deploy.

1. Boot normally and confirm `/healthz` returns 200 with `ok: true` and `version`.
2. Using a staging-only database proxy/network control, block the serving pool
   **after boot**, including its existing pooled sockets, or reject queries at the
   proxy. Merely denying new connections while existing pooled sessions still
   work does not exercise this outage. After the one-second cache expires, probe again:
   require 503 with `database_unavailable` within approximately two seconds of
   the request (plus network/scheduling time), not a raw driver error or stale 200.
3. While admission is denied, issue concurrent health requests. Confirm the
   checker does not enqueue a query per request or allocate another pool. Restore
   the proxy; once the old query actually settles and the short cache expires,
   require a fresh successful observation and 200 without restarting the server.
4. Separately stall (rather than reject) one readiness query: repeated probes
   remain 503 until that raw query settles; a late completion must not by itself
   report recovery. Save statuses, timings, and staging proxy query counts.

No orchestrator-specific behavior or files are part of this change.
