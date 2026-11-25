# Stopping sandboxes after authority loss

An ordinary sandbox already in `stopping` with a durable stop request can lose
its owner's membership or its original provider credential. Automatic reconciliation
then records **Operator cleanup required** in `lifecycle_error` and closes the
automatic retry loop (`reconcile_after = infinity`). This is an actionable
operator hold, not a successful stop. Status, stop request, generation, retained
machine identity and physical-outcome timestamps remain unchanged.

This does not grant the removed owner any new authority. Do not restore membership,
borrow another user's credentials, create a replacement machine, or discover a
machine by a mutable name to clear this condition.

## Trusted operator procedure

This procedure requires an authorized infrastructure operator; it is not a user API
or permission bypass. Do not execute it as part of a PR or an audit.

1. Record the sandbox UUID, lifecycle generation, stop generation, exact persisted
   provider machine ID and original provider binding. For Modal include the immutable
   workspace/environment/App; for Boat include the original account. Confirm there
   is no active activity or reconciliation lease. Keep the retained data.
2. Use separately authorized operator access to **that original provider identity**
   to observe and, if needed, stop only that exact machine. If that identity cannot
   be recovered, leave the hold and escalate to the provider/account operator.
   Transport failures, missing credentials and SQL status are not proof of exit.
3. Record provider evidence of confirmed stop or definitive absence for that exact
   identity in the operator incident record. Do not infer absence across accounts.
   Before publishing a Boat stop, obtain an archived observation for that exact
   machine in its original account. Require snapshot availability, no current
   stop or pending or failed snapshot attempt, and a snapshot verification time
   at or after the reported stop time (use the successful completion time when
   Boat omits the verification time). Confirm that the data has not expired and
   snapshots are enabled. If any of this evidence is unknown, leave the hold.
4. In a transaction lock the original row and compare the recorded lifecycle
   generation, stop generation, provider binding, exact machine ID and pending stop
   request. Require status still stopping or failed with a pending stop and no live operation lease.
   If anything changed, abort and investigate; never publish an old observation over
   a resumed generation. Only with confirmed evidence set status stopped
   (for Boat, definitive absence never authorizes this transition),
   stopped_at to the evidence time, stop_requested_at null, lifecycle_error null,
   and clear reconciliation leases. Keep a failed row’s diagnostic and status when recording exit. Do not delete retained identity or data.

For Modal, if original normal authority is legitimately available again, the operator may
instead requeue the same fenced row by setting reconcile_after to now and clearing
the hold diagnostic under the same transaction/preconditions. Normal reconciliation
must still observe the provider; requeueing alone never proves physical exit.

Boat stops run as one generation-bound job. The absolute deadline for that job does not restart when provider authority changes. For a held Boat job, follow the exact-identity procedure above. Check the shared job lease as well as activity and reconciliation leases before using operator authority.

Docker-host reservations use their separate authenticated host mailbox/TTL cleanup
path and are never claimed by this Boat/Modal worker. This change neither grants
removed-user access on Docker nor substitutes a different host identity.
