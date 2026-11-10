# Ordinary Modal stop recovery (#776)

Ordinary Modal stop attempts one checkpoint (runner, scrub, filesystem snapshot).
The dispatch is persisted before the RPC. If it fails or the server loses its
outcome, the next stop dispatch skips checkpointing and terminates the exact
registered physical machine. Only confirmed termination settles the row to
stopped; a provider outage must not be reported as success. Reconciliation keeps
retrying termination, not checkpoint or failed work capture.

The status/stop receipt includes the closed preservation note
`checkpoint_failed_disk_not_retained` on fallback. No current disk checkpoint is
promised; resume is refused rather than silently restoring stale files. Earlier
encrypted work recovery archives remain available. Golden builders and native
orchestrator checkpoints retain their fail-closed behavior.

The server logs `modal_lifecycle_step_failed` with closed stage, reason,
providerStatusClass and, when supplied, processCategory/processFailure fields.
No raw SDK messages, commands or process arguments are logged. The shared process
scrub policy belongs to #732 / #765, not this recovery change.

## Existing stuck rows

After an operator deploys the server, the ordinary lifecycle reconciler handles
existing stopping rows automatically after their activity/reconciliation leases
expire. Legacy rows without an attempt marker get at most one further checkpoint
dispatch, then plain terminate on the next pass. No SQL edits or migrations are
required. An authorized operator can also retry `armada stop <full-sandbox-id>`
after the lease expires, then check `armada status <full-sandbox-id>`.

Reported rows to verify: production `3a21e24d-a035-4893-ad2c-ce256f622e16`,
`250320dc-d28b-4bdc-9f27-1bdef3ceb619`; staging prefixes `a2af8c47`,
`64a6353b`, `2fae4971` (resolve full IDs with `armada list`).
This patch does not assert these machines have already been reconciled.
No production operations or deployments were performed during implementation.
