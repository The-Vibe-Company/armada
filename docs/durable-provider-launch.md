# Durable launch admission for Modal and Boat

Design proposal for #2600. Implementation and contract rollout require
coordinator approval.

## Decision

A launch belongs to a durable sandbox record from admission onward. Today,
[the shared launcher](../packages/core/src/launch.ts) forks before registering
the sandbox and omits the adapter's idempotency key. Its request-scoped deadline
outlives the server's [25-second shutdown grace](deployment-draining.md).
A restart can lose the fork receipt and leave both paid compute and a golden
operation fence behind. Modal also takes the source lifecycle lease through
the child's entire boot, so concurrent forks can fail with `fork_source_busy`.

Use the [normal Docker launch queue](../packages/mcp-server/src/docker-normal-launch.ts)
as the precedent for acknowledgements, progress and worker claims. REST and
MCP ordinary launches share the new admission service. Template launches,
including scheduled callers, also reach the shared launcher and already have
request receipts. Audit those callers and the scoped-child launch path
(including its direct fork) during implementation. Route eligible golden forks
through durable execution while preserving their existing receipt, authority
and parent-lifecycle semantics. Keep builder, connect and snapshot operations
on their existing lifecycle.

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

Add a server-owned `provider_launch_requests` table keyed by sandbox ID.
Store the scoped request key, digest, actor epoch, encrypted frozen launch
inputs, fence reference, phase, dispatch deadline, next attempt, lease owner,
lease epoch and expiry. Store the correlation ID and a safe outcome for
status and support. Keep prompts and any secret material out of logs and JWT
reads. Recheck pinned credential references and authority before dispatch.
Retain deduplication receipts for the documented replay window and purge
sensitive payloads once execution and recovery no longer need them.

| Sandbox status | Worker progress |
| --- | --- |
| `starting` | Queued, resolving snapshot, booting, preparing harness or reconciling an uncertain outcome |
| `ready` | Prepared for prompts. For a launch with a prompt, persist initial prompt delivery before reporting successful launch completion |
| `running` | Initial turn accepted, with its conversation and prompt IDs available through the launch result or events |
| `failed` | Terminal launch failure with a safe reason, with any unfinished cleanup explicitly tracked |
| `stopped` / deleted | Cancellation or removal won. Pending provider cleanup stays recoverable independently of the public status |

## Worker and recovery

Claim eligible rows in creation order using a bounded pool and
`FOR UPDATE SKIP LOCKED`. Renew short leases and condition writes on the
current lease epoch. Stop claiming on shutdown. A successor takes an expired
claim and resumes from the durable phase. Persist dispatch intent before
crossing the provider boundary. Check cancellation, expiry, actor epoch and
provider binding before dispatch, adoption and initial prompt delivery.
Provider calls that outlive a lease remain discoverable by the same key.

For Modal, hold the source lifecycle lease only to recheck the exact ready
snapshot and persist the child reservation and image reference. Make image
retirement honor that reference, then release the source lease before
booting under the child lease. Retry source contention in the queue within
the launch deadline. For Boat, keep the golden revision fenced until the
provider has acquired its own durable reference or the fork outcome is resolved.

When the receipt is missing, reconcile using the persisted provider binding,
sandbox ID and expected ownership. Modal can resolve its reservation by
request key and reconcile the reserved physical name. Boat forwards a create
idempotency key today. Before enabling Boat, establish its replay window and
a scoped authoritative lookup or equivalent recovery proof. Verify ownership
and original launch identity before adoption or deletion. Replay creation
only while deduplication is guaranteed or absence and no in-flight allocation
are established. An ambiguous outcome stays in reconciliation with bounded
backoff and an operator-visible reason.

Attach the provider ID once, then resume preparation from durable checkpoints.
Record initial prompt intent separately and use a stable dispatch identity
where supported. For native paths with an ambiguous send, reconcile from
provider events or report the uncertain outcome without sending it again.
If the sandbox is cancelled, expired or unauthorized, recover any late fork
and delete the verified resource. Release the fence after a durable child
reference protects the snapshot, or after confirmed absence/removal. Retry
cleanup independently of launch claims so terminal rows cannot strand fences.
Legacy fences require their own ownership and absence checks.

## Client contract and rollout

Expose the Docker-style accepted response on the negotiated REST launch
contract (HTTP 202), with the Armada ID, `starting` and shared launch progress.
The corresponding MCP tool result carries the same semantics. Provider,
conversation and prompt IDs are optional until assigned. Status and events
are the source of progress and terminal results. Prompt and execution controls
return the existing not-ready outcome until their prerequisites are present.
Stop/delete record cancellation even when there is no provider ID. Existing
wait and notification semantics continue to follow the initial turn once it
exists. Launch failures before a turn surface in status/progress.

Update CLI launch output and wait-by-ID behavior, the MCP schema and tool
guidance, dashboard launch and sandbox views, and SDK result types and
examples. Version or explicitly negotiate the response change. Keep legacy
synchronous clients on a compatibility path until consumers support
admission, then retire it. During transition, any compatibility wait over
durable admission ends with the same sandbox ID available for status or replay.

Apply an additive migration first, strictly newer than main, using the
existing server-only grants and RLS pattern. Allow a null provider ID only
for explicitly tracked pre-allocation rows and terminal rows that never
acquired one. Keep identity immutable after assignment. Update SQL triggers,
uniqueness, readers and provider-bound operations for the pending state
before enabling writers. Ship readers and recovery before admission,
then enable per provider after crash and concurrency acceptance. Rollback
disables new admission while compatible workers and recovery drain existing
rows. Existing sandboxes keep their IDs and require no launch-row backfill.

Implementation acceptance should cover admission replay, stale claims and
cancellation using deterministic unit tests. Verify real-provider restart
recovery across the fork/receipt boundary and overlapping forks from one
snapshot through the authorized provider acceptance paths, including
coordinator-only verification for Boat.
