# Last-good retention and superseded saved revisions

Secure Boat and Modal rebuilds use fresh random revision labels and retain the
provider-returned **saved handle**, never the underlying raw artifact ID. The
ready replacement, repository config, null restored-master pointer, backend slot,
durable job success, publication provenance and old→new retirement outbox entry
commit in one SQL transaction. No old revision is deleted inline, in build
`finally`, or before publication. Failed/rolled-back builds retain last-good;
a lost COMMIT acknowledgement never authorizes deleting a possibly committed
artifact. Existing disposable-builder cleanup remains a separate build protocol.

## Revision admission and permanent collection barriers

Launch, connect and snapshot admission carry the snapshot **and master pointer
read by that operation**. SQL locks the canonical golden and compares both before
recording a durable operation fence. A stale reader cannot fork a revision that
has since been replaced/retired. Ambiguous forks retain their fences indefinitely:
age, lease expiry and lack of a child receipt do not prove no VM was allocated.

Publication, admission and retirement claim serialize on the golden row and a
provider/saved-handle advisory lock. Before a delete, the service checks every
canonical pointer, including private/hidden and logically removed rows; unresolved
operation fences; busy backend reservations; and queued/running/recovery jobs.
Legacy in-flight jobs with unknown expected revisions conservatively protect all
candidates on that provider. Succeeded jobs are provenance, not permanent live
references. Boat compatibility-pointer writes pass the same barrier.

A successful collection claim seals an irreversible SQL barrier for that handle.
No pointer/publication can reintroduce it while deletion is in flight or after it
is retired. Locks and reference checks are deliberately conservative across
accounts with the same provider/handle: hidden protection is reported only as a
generic protected/deferred reason, never another resource's identity.

## Provider proof and deletion

The service-only ledger/outbox retains the golden ID, immutable source target
(org/owner/visibility/Modal workspace-environment-App), backend account identity,
credential **scope and owner** (no credentials), source builder, saved handle,
underlying artifact fingerprint and successful producer job when available.
Proven publication identities/fingerprints cannot be rewritten. Missing facts
produce deferred work, never an orphan/name-prefix/age guess.

Immediately before deletion the worker re-resolves the persisted management
authority, checks current membership/owner/admin rights, account/binding,
source/artifact fingerprint, a proven ready current last-good snapshot and a stopped or
absent proven source. It rechecks SQL references/authority under locks before
recording delete intent. Changed identity, source, fingerprint, ACL or unavailable
provider means retain/defer. It never starts, resumes, stops or deletes any VM,
master, builder, child, disk or raw snapshot. Its sole destructive call is
`Provider.deleteSnapshot(savedHandle)`.

For Boat this is
[`DELETE /saved-snapshots/{name}`](https://docs.boat.dev/api/reference/snapshots/delete-saved-snapshot),
whose contract preserves already-deployed children. `SnapshotInfo.name` is that
saved handle; optional `artifactId` maps the SDK's separate `snapshotId` solely as
a fingerprint. It is never passed to deletion. Random rebuild revision handles
are permanently claimed in SQL before the first upstream save. The service also
requires an upstream not-found read before saving a rebuild label, so an existing
foreign handle is never overwritten. Failed attempts retain their namespace
claim; disappearance does not authorize name reuse. Unproven namespace claims
are not publication/retirement proof, and become proven only in the successful
publication transaction.

Modal uses its existing saved-image tombstone, `collectImages` and durable
`imageReferenced` checks, including stopped-child recovery and cross-visibility
source-image references. Removing a saved label does not erase recovery references
or authorize raw Image deletion. No provider-specific raw deletion is added.

## Independent retry and shutdown

Retirement is a separate tracked lane, not coupled to the build worker or an HTTP
request. One candidate is admitted per tick, with a 30-second action budget and at
most four outstanding SDK operations per replica. Timed-out SDK calls remain
tracked through shutdown; cancellation forbids subsequent provider actions. SQL
claim IDs serialize replicas. Claim expiry only permits readback, **not** replay
of a possibly allocated provider deletion.

The durable `delete_started` marker is set before requesting deletion. A confirmed
success or same-authority absence readback acknowledges retirement. A definite
non-mutating refusal may retry after credentials/provider recovery. Unknown/lost
provider responses retain the barrier and become readback-only: a still-present
handle is not deleted again merely because a claim expired. Safe enum reasons,
not upstream errors, are persisted/logged. Cleanup failure cannot fail a committed
rebuild. Permanently unavailable/ambiguous artifacts may remain retained; there
is no unsafe force-delete override.

## Historical dry-run and reconciliation

After applying migration `20261110120400_golden_snapshot_retirement.sql`, use the
API-only CLI against the normal Armada origin:

```sh
armada golden retirement dry-run GOLDEN_UUID --org ORG_UUID --limit 20 --json > review.json
# Review the exact proof/fingerprints in review.json before confirmation.
armada golden retirement reconcile GOLDEN_UUID --org ORG_UUID --limit 20 --file review.json --json
```

Equivalent authenticated POST routes are
`/api/v1/golden/retirement/dry-run` and
`/api/v1/golden/retirement/reconcile`, with `{ id, org, limit }` for dry-run, and additionally `receipts` (the reviewed
64-character proof digests) for reconcile (`1..50`, default
`20`). The dashboard proxy exposes exactly those two closed authenticated paths.
Only a private owner or organization admin may operate on the selected golden;
live membership is rechecked. Results contain only that golden's old/new handles,
`eligible`/`protected`/`deferred` and safe reason codes. Eligible results include the
exact non-secret account/authority, source/artifact/producer-job and replacement
proof, plus an optimistic-concurrency `receipt` bound to those facts and the
canonical current revision. Receipts are not authorization credentials: every
request still rechecks owner/admin membership. No plaintext encrypted job payload
or credential is returned. Reconcile refuses missing receipts; changed facts
produce `review_changed`, requiring a new dry-run/review. The reviewed digest and
reviewer identity are retained on the outbox, while automatic publication entries
are authorized by their atomic successful publication transaction.

Dry-run makes no SQL/provider mutations and enqueues nothing. Reconcile only
records proven candidates; deletion is left to the independent worker and all
its current reference/provenance checks. There is no account-wide snapshot scan.
Historical reconstruction starts at the canonical current handle and follows
singleton succeeded job chains. Decrypted successor `existingGolden` must name
the exact predecessor/target; both producer `snapshot` + `builder_id`, matching
account/binding and live artifact/source fingerprints are mandatory. Ambiguous,
missing or conflicting history is deferred. A producer job alone, an unused
handle, missing slot, old name, age, or stopped child proves no ownership.

Legacy org builds have a provable org-only management selection. Legacy private
builds without explicit provenance cannot distinguish a personal key from org
fallback and are retained/deferred. New publications retain explicit authority,
so subsequent private rebuilds can retire their proven predecessors. Revoked
producer membership/management availability also defers rather than adopting a
new authority silently.

Current handles (including tombstones), unknown-ownership handles, legacy
prod-smoke artifacts and stopped children are outside historical superseded-chain
collection. No production build, grant, provider mutation or reconciliation is
performed by tests or this PR. Integration/root must review dry-run/provenance
receipts before any production reconciliation; apply the migration before the
server release. No automatic historical backfill runs on deployment.

Provider source/artifact metadata is correlation, not a cryptographic ownership
proof or an atomic compare-and-delete API. Armada serializes its own namespace,
checks exact provider readback and never reuses its claimed revision names.
Out-of-band provider administrators must not overwrite managed revision handles;
observed changes defer collection. The saved-handle API is used as documented,
never a supposedly stronger raw-disk delete shortcut.
