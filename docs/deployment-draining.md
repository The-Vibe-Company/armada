# Railway deployment draining

## Configuration and sources

The shared [Railway IaC](../.railway/railway.ts) declares
`overlapSeconds: 180` and `drainingSeconds: 30` for the server. The authorized
operator should confirm those effective settings in staging and production.

[Railway teardown documentation](https://docs.railway.com/deployments/deployment-teardown)
distinguishes overlap (old version remains active after the new one activates)
from draining (time between SIGTERM and SIGKILL). Thirty seconds provides five
seconds of host headroom over Armada's 25-second application shutdown deadline.
Both revisions can access the shared database during overlap and drain. Follow
the [migration author checklist](database-migrations.md#migration-author-checklist)
when removing schema objects or introducing enforcement.

## Timeline (relative to activation, not build start)

This is the intended sequence from Railway's documented lifecycle plus Armada's
shutdown implementation, **not a measured routing-propagation guarantee**:

- Before t=0: the candidate builds/boots while the old deployment serves. Existing
  `/healthz` must return 200 before activation; its 180-second startup healthcheck
  timeout is **not** termination grace. See [healthchecks](https://docs.railway.com/deployments/healthchecks).
- t=0 through the 180-second overlap: the candidate is active and the previous
  deployment stays up. Old processes can still run background workers, read and
  write shared state, serve requests that reach them, and process messages on
  existing sockets. In-flight turns can continue across activation while their
  connections are live. Activation alone gives no guarantee about which
  deployment handles a request or when any particular socket disconnects.
- At the end of overlap: Railway begins tearing down the previous deployment.
  Measure the drain deadlines below from the old process receiving SIGTERM.
- t=0 through t<25, measured from the old process receiving SIGTERM: Armada stops
  admission (late requests get 503 + Retry-After if they reach its handler),
  signals workers to stop, and closes runtime WebSockets with code 1012 so
  runtimes can reconnect. It lets admitted handlers and POST tool-response
  streams finish, closes MCP/idle GET streams, completes native HTTP shutdown,
  then closes SQL. A turn can still be running when its transport disconnects.
  Overlap and draining do not guarantee uninterrupted event delivery across
  reconnects. If shutdown settles, Armada exits 0 immediately.
- t=25 from SIGTERM: if still pending, Armada logs the fixed shutdown-deadline
  reason, force-stops HTTP and exits 1. Remote actions can remain ambiguous; do
  not blindly replay a launch or prompt. Reconciliation only covers registered
  resources, not every uncertain remote allocation.
- t=25–30: host headroom, not additional application work time.
- t=30 from SIGTERM: Railway may send SIGKILL if the old process remains. A wedged
  event loop may prevent Armada's timer from firing, so the host bound matters.

This does not guarantee all launches finish (many take longer than 25 seconds),
fix runtime database readiness, or provide mutation deduplication. Abrupt host
failure/SIGKILL remains outside graceful shutdown. No provider or model requests
are replayed by this configuration.

## Operator staging check: `drain-grace-cutover`

Run this check only in staging.

1. Confirm staging resolves the IaC to 180 seconds of overlap and 30 seconds of
   draining. Establish a staging deployment with these settings and the shutdown
   implementation, then replace it in a second authorized deploy to exercise
   its teardown policy.
2. Arrange for one controlled request on a disposable staging sandbox to be
   active on the old deployment at SIGTERM and finish within 25 seconds of the
   signal. Account for the overlap when timing the request. Record timestamps
   for activation, old-process
   drain log, client response, process exit, and sandbox identity. Confirm response
   completion before exit 0, no premature SQL/MCP close, and one sandbox only.
   Confirm fresh traffic reaches the new version. Idle MCP notification streams
   must not prevent shutdown.
3. In a separate controlled staging run, keep admitted work pending beyond 25
   seconds. Expect Armada's deadline log and exit 1 at approximately 25 seconds,
   **not** immediate host kill at SIGTERM. If the process is deliberately wedged,
   observe the host's approximately 30-second kill bound instead. Check registered
   sandbox reconciliation afterward; do not assert remote rollback from exit code.
4. Save deployment IDs, resolved config and timings in the acceptance record.
   Failure to observe the configured grace blocks rollout validation; repository
   schema checks alone do not prove the platform applied it.
