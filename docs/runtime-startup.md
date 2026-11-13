# Enrolled Codex startup (#1161)

`packages/mcp-server/src/runtime-startup.ts` coordinates the trusted launch
sequence: encrypted configuration issuance, private host bootstrap, enrolment,
and epoch-bound runtime health. It builds on #1300's agent bridge; it does not
register a public launch switch or change Boat defaults/Modal behavior.

The caller supplies the already-authorized persisted logical/physical sandbox
binding, pinned public artifact metadata, private runtime configuration and two
ports: bounded host `bootstrap`, and the matching agent bridge's `health`.
The host port receives only the single-use ticket and public install metadata,
never model configuration. It can be bound to #1292's `startBoatRuntime` without
coupling this service to an SSH/provider implementation. The readiness receipt
is only `{runtime:"armada",epoch}`; no credentials/configuration are returned.

## Admission and failure ownership

Call only for a **fresh/quiescent** sandbox under the existing exclusive launch
or lifecycle lease. The caller must quiesce old work first and own allocation
cleanup/status failure publication if startup fails. This is not a concurrent
repair service, stop/resume implementation or automatic bootstrap retry loop.
Never call it again to recover an uncertain consumed ticket without reconciling
and quiescing the allocation through that lifecycle owner.

Private `issue` now returns the predicted next enrolment epoch and current
lifecycle generation alongside the ticket. The epoch is not reserved: repeated
issuance before consumption can predict the same epoch, so exclusive issuance
under the caller's lease is essential. No SQL/wire schema changes are needed.
Existing ticket replay behavior, encrypted storage and runtime session responses
are unchanged.

After bounded host bootstrap returns, readiness has a default 90-second budget
(max 120s). Polls release SQL locks before waiting. Health must belong to both
the issued epoch and the same lifecycle generation; final authority is checked
again after health, so stop/replacement cannot publish an old healthy receipt.
The health RPC receives a deadline/caller cancellation signal. Host bootstrap has
its own bounded transport budget; cancellation is checked between phases, not
claimed to cancel a detached guest/SSH process. Deadline/abort/bootstrap failures
produce fixed safe diagnostics. They never silently start Boat's native runner,
repeat the host bootstrap or reissue a ticket. Caller cleanup must fence any
late enrolment/health and stop the failed allocation.

## Coordinator check

Zero Boat starts or model calls, no migrations/deployment prerequisites:

```sh
bun test packages/mcp-server/test/runtime-commands.test.ts --test-name-pattern 'runtime startup|startup never'
```

Expected: encrypted configuration is consumed once, old runtime authority is
revoked before the host handoff, only public metadata/ticket reach bootstrap,
and real Runner health admits the correct epoch without starting a driver turn.
Selection, pre-abort, bootstrap failure, readiness timeout, stop, epoch replacement
and logical lifecycle replacement cannot publish ready or retry bootstrap.
Tests use local migrated SQL and an injected clock, not network or sleeps. The
host/driver install is covered by its existing boundary, not repeated here.

The first-answer milestone still needs per-launch opt-in/durable routing,
server-side launch configuration projection, actual port binding and cleanup
integration into launch/later reads. The exact ONE-launch coordinator check will
be posted on #1161 when main supports it. This PR is not a Boat inference proof.
