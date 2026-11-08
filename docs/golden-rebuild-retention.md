# Last-good retention for secure Boat rebuilds

The secure create/update service keeps one logical golden and its existing
account binding. Rebuilds request a fresh, random `golden-r-<uuid>` saved-snapshot
label (within Boat's 63-character naming limit), retaining the provider-returned
reference as the revision pointer. They never save over the
previous pointer's artifact. Historical golden rows, names and ACLs do not change.

The disposable no-env builder is scanned before snapshotting. Only a ready
snapshot may enter persistence. A database transaction locks/rechecks the previous
pointer, then updates config, snapshot pointer, restore strategy and reservation
together. A database without transaction support refuses the build before a
builder is started.

## Restored master strategy

Successful secure builds store a null sandbox pointer and a ready snapshot pointer.
This means **restore from the committed snapshot on connect**, not “use the stopped
builder.” The builder is always stopped during cleanup. Connect forks the committed
snapshot with `noEnv: true`, waits for readiness and only then records the restored
master. Stopped or provider-missing masters also restore this way. Failed restoration
does not publish a new master pointer and stops the attempted restore.

## Failure behavior

- Scan failure: no snapshot is requested and old config/pointers remain unchanged.
- Snapshot failure: old artifact/config/pointers remain unchanged. Cleanup removes
  only this attempt's known, settled artifact.
- Lost snapshot response: cleanup needs exact requested-name lookup and builder
  source provenance. Once a response supplies a verified reference, cleanup uses
  that reference instead. In-flight saves and uncertain ownership are retained.
- Persistence failure: the transaction rolls back the pointer/config/reservation.
  Before deleting an untracked revision, cleanup must positively verify that no
  database golden references it. An unavailable database or a commit whose response
  was lost therefore never causes deletion of a committed last-good snapshot.
- Successful update: the old artifact remains available; only the one logical row's
  pointer and config advance. This change does not garbage-collect old revisions.

Tests use the real factory, migrations and transactional database, injecting scan,
snapshot, lost-response, finalize/rollback and lost-commit-acknowledgement failures.
The fake provider stores artifact contents and stopped/running machine state; tests
restore and check the committed contents rather than merely checking call counts.

## Explicit limits

This is secure rebuild atomicity/last-good retention, not exclusive leases, crash
recovery, distributed transactions, or a revision-history/garbage-collection system.
A process crash may leave a pending reservation or an untracked snapshot. Old live
masters are not garbage-collected by this change. Manual `golden_snapshot` capture
is an existing separate flow, not redesigned here. No production build, migration,
or legacy adoption is required or performed for this code change.

## Snapshot reference contract (review correction)

Verified against installed @boatdev/sdk@1.13.0 generated models
(src/models/SavedSnapshot.ts, SavedSnapshotSaveRequest.ts), Boat's
[save endpoint](https://docs.boat.dev/api/reference/snapshots/save-saved-snapshot)
and [published OpenAPI](https://docs.boat.dev/openapi/boat-v1.yaml),
schemas SavedSnapshot and SavedSnapshotSaveRequest:

- Boat's name is the account-scoped user-chosen saved handle. Saves request that
  name; lookup/deletion address the saved handle. The optional snapshotId is a
  separate underlying disk artifact reference (used by the tree endpoint).
- The Boat adapter exposes the response's saved name as SnapshotInfo.name,
  preserving sourceSandboxId. It does not substitute the disk artifact ID.
- The shared Provider contract does not promise label/reference equality.
  The service now preserves the returned reference for polling, persistence and
  cleanup. A remapped reference requires matching source correlation with this
  attempt's fresh builder (from the response or lookup). Missing/wrong provenance
  fails closed; the last-good pointer is never accepted as a new revision.
  Source metadata is provider-reported correlation, not cryptographic ownership
  proof or a distributed lock.
- Adapter-boundary tests run the real Boat SDK over fake HTTP responses with
  distinct requested label, returned saved handle and underlying artifact ID.
  They verify polling/persistence and failed-persistence deletion use the returned
  saved handle. This is defensive compatibility testing, not evidence that Boat
  currently remaps names in production. Unit regressions also cover provenance
  lookup and rejection of missing/wrong source or last-good remaps.

Only public documentation and local SDK code were inspected; no authenticated
production snapshot requests or mutations were made.
