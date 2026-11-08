# Golden capacity and lifecycle follow-ups

This authorization fix does not migrate, adopt, delete, or rewrite any legacy golden,
its history, its owner/visibility, or its backend slots. A Boat golden without an
existing slot on the currently resolved account now fails connect, snapshot and
rebuild with a generic `conflict`. Changing credentials does not move a golden.

## Separately mergeable: explicit legacy binding

Design an administrator-invoked, dry-run-first reconciliation command. Inventory
legacy rows and provider artifacts using a verified backend identity; detect
multiple goldens, conflicting accounts, missing artifacts, and occupied capacity.
Require explicit golden/account selection and owner/admin authorization. Claim a
slot atomically only after verifying provenance and capacity; never infer adoption
from a name, launch, connect, snapshot, or rebuild. Preserve IDs, history and ACLs;
refuse ambiguity without deleting anything. Test wrong-account, duplicate, full
account, concurrent claim, rollback, and private-owner boundaries. No production
reconciliation is performed by this ticket.

## Remaining capacity/concurrency limits

Connect/snapshot check the durable account binding and reject a slot whose build
is already pending. This is an admission check, not an exclusive lease spanning
remote work: another mutation can start after the check. A separate change should
unify connect/snapshot/rebuild behind an atomic mutation lease, with failure and
crash recovery. Rebuild retains the existing reservation protocol. Capacity tracks
logical goldens, not temporary builders, restored masters, or orphaned provider
artifacts. No periodic reconciliation or crash-expired reservation recovery is
introduced here. Non-Boat providers without declared capacity keep their existing
behavior.

## Remaining lifecycle limits (not redesigned here)

Snapshots still use replaceable names, not immutable revisions. Rebuild persistence
still records a disposable builder that cleanup stops. Connect can replace a stopped
master from a saved snapshot; a golden with no master ID still conflicts. Snapshot
routes do not repair stopped/missing masters automatically. Restore/persist failures
can leave remote artifacts; leases, garbage collection, immutable revision history,
and durable master ownership need their own design. No frontend changes are included.
