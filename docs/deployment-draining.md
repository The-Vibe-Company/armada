# Railway deployment draining

For #972; completes the host-side prerequisite of #975. No release-model change.

## Configuration and sources

The shared `railway.json` sets numeric `deploy.drainingSeconds: 30` and
`deploy.overlapSeconds: 0`. The current [published schema](https://railway.com/railway.schema.json)
accepts nonnegative numbers (or null) for both. Use numbers, despite quoted
examples in some documentation.

Both **staging and production** inherit this base config: there are no
`environments` overrides in the file. Railway's [config precedence](https://docs.railway.com/config-as-code/reference)
places environment-specific code above base code, then service settings. Both
services must use this config file; the authorized operator should confirm their
resolved settings. Do not add a staging/production override that shortens grace.

[Railway teardown documentation](https://docs.railway.com/deployments/deployment-teardown)
distinguishes overlap (old version remains active after the new one activates)
from draining (time between SIGTERM and SIGKILL). Thirty seconds provides five
seconds of host headroom over Armada's 25-second application shutdown deadline.
Zero overlap avoids intentionally extending old-version admission; overlap is
not a replacement for termination grace.

## Timeline (relative to activation, not build start)

This is the intended sequence from Railway's documented lifecycle plus Armada's
shutdown implementation, **not a measured routing-propagation guarantee**:

- Before t=0: the candidate builds/boots while the old deployment serves. Existing
  `/healthz` must return 200 before activation; its 180-second startup healthcheck
  timeout is **not** termination grace. See [healthchecks](https://docs.railway.com/deployments/healthchecks).
- t=0: the candidate becomes active. With zero configured overlap, Railway starts
  retiring the old deployment without an intentional overlap delay and sends
  SIGTERM. Routing and signal delivery need not occur at exactly the same instant.
- t=0 through t<25, measured from the old process receiving SIGTERM: Armada stops
  admission (late requests get 503 + Retry-After if they reach its handler), drains
  admitted handlers and POST tool-response streams, closes MCP/idle GET streams,
  completes native HTTP shutdown, then closes SQL. If all settle, it exits 0
  immediately; it does not sleep out the grace period.
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

Do not run this against production. No deployment was performed to validate this PR.

1. Confirm staging and production resolve this file with overlap 0 / draining 30,
   without environment overrides. Do not assume an already-running deployment
   retroactively acquired new code/config. In staging, first establish a deployment
   containing #975 and this config, then replace that deployment in a second
   authorized deploy to exercise its teardown policy.
2. On a disposable staging sandbox, start exactly one launch/request on the old
   deployment shortly before the cutover. Choose controlled work that completes
   within 25 seconds of SIGTERM. Record timestamps for activation, old-process
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
