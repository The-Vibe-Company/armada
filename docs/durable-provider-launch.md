# Durable launch admission for Modal and Boat

Design proposal for #2600. Implementation and contract rollout require
coordinator approval.

## Decision

A launch belongs to a durable sandbox record from admission onward. Today,
[the shared launcher](../packages/core/src/launch.ts) forks before registering
the sandbox and omits the adapter's idempotency key. Its request-scoped deadline
outlives the server's [25-second drain deadline](deployment-draining.md).
A restart can lose the fork receipt and leave both paid compute and a golden
operation fence behind. Modal also takes the source lifecycle lease through
the child's entire boot, so concurrent forks can fail with `fork_source_busy`.

Use the [normal Docker launch queue](../packages/mcp-server/src/docker-normal-launch.ts)
as the precedent for acknowledgements, progress and worker claims. REST and
MCP ordinary launches share the new admission service. Template launches,
including scheduled callers, keep their existing request receipt and frozen
manifest. Scoped children keep their parent-generation reservation and
operation key, including on the direct fork path. Both need dedicated adapters
before joining the queue so they never double-admit or bypass their authority
checks. Builder, connect and snapshot operations keep their existing lifecycle.

## Admission and states

Authenticate and resolve placement, membership, golden revision, immutable
provider binding, runtime strategy and credential references before committing.
In one transaction create a `starting` sandbox with a generated Armada ID and
no provider ID, its launch request and a revision-specific golden fence.
Return the receipt after commit. A client request key scoped to actor and org
plus a canonical request digest makes a lost admission response replayable.
The same key and digest return the same sandbox and current state. Reuse with
different input returns conflict. The server always uses the Armada sandbox
ID as the provider idempotency key, independent of the client's key.

Reuse the key namespace and authority pinning of `ordinary_launch_receipts`.
Reserve the key in the same transaction as the sandbox and queue row, using
the receipt ID as the sandbox ID. The new contract requires a client key.
Legacy keyless REST stays synchronous and keyless MCP retains its generated
key. Version the digest rules to preserve each legacy surface's comparison.
Read the shared namespace before routing a replay. Completed legacy receipts
remain replayable and incomplete ones inspect-only. `launch_receipt` keeps
its legacy authority and allocation checks, and reads the owned sandbox and
queue state for linked receipts. Retain immutable key, digest and outcome
tombstones after purging encrypted payloads.

Add a server-owned `provider_launch_requests` table keyed by sandbox ID.
Link the ordinary receipt where applicable. Store the actor epoch, encrypted
frozen launch inputs, fence reference, phase, dispatch deadline, next attempt,
lease owner, lease epoch and expiry. Store the correlation ID and a safe
outcome for status and support. Keep prompts and any secret material out of
logs and JWT reads. Recheck pinned credential references and authority before
dispatch. Purge encrypted launch inputs once execution and recovery no
longer need them.

| Sandbox status | Worker progress |
| --- | --- |
| `starting` | Queued, resolving snapshot, booting, preparing harness or reconciling an uncertain outcome |
| `ready` | A promptless launch has prepared the harness, or the accepted initial turn has already finished |
| `running` | Initial turn accepted, with its conversation and prompt IDs available through the launch result or events |
| `failed` | Terminal launch failure with a safe reason, with any unfinished cleanup explicitly tracked |
| `stopped` / deleted | Cancellation or removal won. Pending provider cleanup stays recoverable independently of the public status |

## Worker and recovery

Register a bounded lane with `startServerWorkers`. Claim eligible rows in
creation order using `FOR UPDATE SKIP LOCKED`, renew short leases and condition
writes on the current lease epoch. Shutdown stops claims and tracks in-flight
work through the existing drain deadline. Successors take expired claims and
resume from durable checkpoints.

Commit each dispatch intent by compare-and-set under the current lease,
checking cancellation, expiry, actor epoch and provider binding. Cancellation
and dispatch serialize on that record. If cancellation wins, no worker can
reserve another dispatch. An earlier intent can complete after cancellation
or lease loss. The successor treats it as uncertain and reconciles by key
before attempting another dispatch or declaring cleanup complete.

For Modal, hold the source lifecycle lease only to recheck the exact ready
snapshot and persist the provider-owned child reservation with the exact
source, image and management authority. Make image retirement honor that reference, then release the source lease before
booting under the child lease. Retry source contention in the queue within
the launch deadline. For Boat, keep the golden revision fenced until the
provider has acquired its own durable reference or the fork outcome is resolved.

When the receipt is missing, reconcile using the persisted provider binding,
sandbox ID and expected ownership. Modal can resolve its reservation by
request key and reconcile the reserved physical name. Boat forwards a create
idempotency key today. Keep Boat admission disabled until its adapter can
prove the replay window and a scoped authoritative lookup or equivalent
recovery. Keep any unresolved dispatch in reconciliation. Verify ownership
and original launch identity before adoption or deletion. Replay creation
only while deduplication is guaranteed or absence and no in-flight allocation
are established. An ambiguous outcome stays in reconciliation with bounded
backoff and an operator-visible reason.

Attach the provider ID through a server-only compare-and-set that verifies
the sandbox, org, bound provider, pre-allocation phase and current lease
epoch. Permit one null-to-known transition and preserve Boat's identity
alias. Resume preparation from durable checkpoints. Record the initial
prompt intent with an immutable dispatch identity. Recover its receipt
through provider correlation where available. If an ambiguous native send
cannot be resolved, report `prompt_uncertain` in status and an event without
sending again. Admission replay only reads the receipt.

If the sandbox is cancelled, expired or unauthorized, recover any late fork
and delete the verified resource. Release the fence after a durable child
reference protects the snapshot, or after confirmed absence/removal. Retry
cleanup independently of launch claims so terminal rows cannot strand fences.
Inventory legacy launch fences during cutover. Reconcile each using its
operation, snapshot, pinned authority and any recoverable sandbox identity.
Require verified adoption or absence/removal before release. Flag unresolved
fences for operator review and preserve them regardless of age.

## Client contract and rollout

Add REST `sandbox/launch-async-v1` and MCP `launch_async_v1` for ordinary
golden launches. A new admission uses HTTP 202 on REST with an Armada ID,
`starting` and phase. Replays report the same ID and current state. Provider,
conversation and prompt IDs are omitted until assigned. Existing ordinary,
sized, access and runtime entry points retain their synchronous schemas
(REST HTTP 200). Keep specialized routes synchronous until they have an
explicit adapter and compatible response contract. Existing keyed routes
that see an async receipt return their synchronous result once available,
or the existing outcome-unknown response with the receipt ID while pending.

Reuse `sandbox_launch_stages`. Insertion records `accepted`. The worker
records `provider_claimed` at reservation or proven claim, `machine_started`
at boot, and the existing checkout, harness and first-token milestones as
observed. Keep detailed queue phase separate for status and terminal events.
Update CLI launch output and wait-by-ID, MCP tool guidance, dashboard launch
and sandbox views, and SDK result types. Status and events report progress
and failures before a turn, while wait and notifications follow the initial
turn once it exists. Provider-bound controls report not-ready before their
prerequisites exist. Stop and delete record cancellation without a provider ID.

Apply an additive migration first, strictly newer than main, using the
existing server-only grants and RLS pattern. Allow a null provider ID only
for explicitly tracked pre-allocation rows and terminal rows that never
acquired one, validated against the request relation. Keep identity
immutable after assignment. Update triggers, uniqueness, readers and controls
before enabling writers. Drain old processes before pending rows can become
visible. Enable per provider after crash and concurrency acceptance. Rollback
disables new admission and retains compatible readers, workers and recovery
until pending rows and cleanup are drained. Existing sandboxes keep their IDs and require no launch-row backfill.

Implementation acceptance should cover admission replay, stale claims and
cancellation using deterministic unit tests. Verify existing template and
scoped-child contracts, and golden retirement around upgrade. Verify real-provider restart
recovery across the fork/receipt boundary and overlapping forks from one
snapshot through the authorized provider acceptance paths, including
coordinator-only verification for Boat.

## Modal boot rollout

The synchronous ordinary Modal path now admits a sandbox, encrypted fork
request and snapshot fence in one transaction. Modal uses a stable logical
provider ID derived from the Armada UUID, so existing identity columns can stay
non-null while physical compute is pending. The worker rechecks authority and
retries the exact Modal reservation by the same UUID. Requests continue to
wait for boot and then run the existing initialization and initial-prompt path.
If the caller disappears after admission, the worker can still finish boot.
The ordinary sandbox lifecycle retires a sandbox whose initialization was
interrupted after that handoff. An owner can stop a pending boot before
allocation. If dispatch already started, the worker uses the pinned Modal
identity to retire the allocation and keeps the golden fence if the outcome
remains uncertain. Receipt inspection reports the persisted boot phase.

This path depends on the previously added `provider_launch_requests` migration.
Modal locks the snapshot source row only through the transaction that pins the
image in the child reservation. A successor can recover that reservation directly
once the renewable child lease expires. The worker checks its persisted lease,
deadline and cancellation immediately before adapter allocation. Once dispatch
expires, unresolved allocations enter leased, delete-only cleanup under the
original Modal authority. The worker clears the recovery request and golden
fence in one transaction after the adapter confirms removal. Ambiguous name
lookups or unavailable authority leave cleanup pending.
The next stages cover durable initialization and initial-prompt checkpoints, versioned async clients, and Boat admission after recovery is proven.
