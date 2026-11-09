# Golden removal (issue #566)

## API and CLI

POST /api/v1/golden/remove with JSON `{ "id": "<golden UUID>", "org": "<optional org selector>" }`.
Returns HTTP 200 with `{ "id": "...", "removedAt": "<ISO timestamp>", "artifacts": "retained" }`.
The same operation is `armada golden remove <golden-id> [--org <org>] [--json]`.
Removal is idempotent for the currently authorized caller. Not found/private/out-of-scope
resources return 404, non-admin org mutations 403, unresolved operations 409.
The response deliberately excludes config, provider identifiers, credentials and child details.

Frontend #563 should use that operation, remove the item from local launch selections
after success, and explain that existing sandboxes and history are retained. User-JWT
golden queries must filter `removed_at=is.null` for selections (the tombstone remains
readable for historical joins). Do not implement this as a direct table DELETE.
The control API/MCP list and SQL golden lookup already exclude tombstones.

## Atomicity and ownership

* A row lock on the golden serializes removal with durable operation admissions,
  backend-slot admissions and build-queue admissions. New sandbox inserts also reject
  removed goldens. Launch admits before calling fork; connect and snapshot admit
  before touching the provider. Removal conflicts while one of those operations runs.
* Existing queued/running/recovery-required builds or busy backend slots block removal.
  Queue admission locks matching golden identities even before an update job has a
  golden_id. A tombstone cannot be rebuilt or recreated under its reserved identity.
* Fences have no time-based expiration. A crashed worker requires explicit server
  operator reconciliation: establish the operation's durable/provider outcome and
  ensure the old worker cannot run again before clearing its fence. Never clear one
  merely because its timestamp or a lease is old.
* Removal itself performs **zero provider calls**. It does not stop masters or children,
  delete images/snapshots, decrement reference counts, or release capacity. All golden
  fields, FK targets, source visibility, owner, model-secret provenance and provider
  binding remain intact. Existing sandbox reads, updates and resume routing still join
  the retained golden. A removed golden is immutable.
* Existing provider image/snapshot reference-count and receipt owners remain the only
  physical lifecycle owners. Retaining the golden's references intentionally keeps
  those artifacts pinned and its backend capacity occupied. This operation does not
  enqueue physical GC or claim cleanup succeeded. A future GC must account for ALL
  retained goldens, children, jobs, receipts and ambiguous physical outcomes; a stop
  acknowledgement is not deletion. No automatic GC/reclaim is introduced here.

## Operational boundary

This change never executes production removal. After independent review, migration
and deployment, the coordinator must authorize and execute the exact owner-requested
golden UUID; it must not delete the golden's stopped children.

## Publication uncertainty and retry reconciliation (review correction)

Connect/snapshot fences now retain ownership when a physical or publication outcome
is unknown. Before sending a CAS, the fence stores the exact proposed canonical
sandbox/snapshot identity. An authorized retry of golden connect or golden snapshot
performs live role verification and a canonical SQL readback. Only receipts whose
entire proposed identity matches the persisted golden can be cleared automatically.
A nonmatching read is NOT proof of rollback of an in-flight transaction. There is
no fence age/lease override.

For a lost connect COMMIT response and readback, retry golden connect once database
availability returns. For a lost snapshot publication, retry golden connect first:
it confirms the immutable snapshot pointer, resolves that publication fence, then
restores the canonical source through the normal provider-scoped path.
Retries never delete retained shared artifacts. Revoked/demoted callers cannot clear
fences. Known completed operations, explicit non-mutating provider refusals, and
acknowledged failed snapshot results release their fences normally.

An outcome with no canonical match (including a physical response lost before an
identity could be persisted) deliberately remains blocked. The existing server
operator owns reconciliation: stop/fence the original worker, establish that no SQL
publication remains in flight, inspect the exact retained provider/receipt references,
and reconcile those references through their existing lifecycle owner before clearing
that specific operation fence. A delete/stop ACK alone is not terminal physical proof.
This conservative case has no automatic retry/GC or timeout-based clearing.

## Trusted admission boundary

Operation fences and their receipts are server-only. Authenticated JWTs cannot
read, create, forge, update, or delete them, including older user-owned rows after
membership revocation or admin demotion. All physical operations must go through
the server/API; directly running a SQL golden store as a user JWT fails admission
before provider mutation. Only trusted provider/server paths release known-safe
outcomes or perform canonical reconciliation. Explicit non-mutating launch refusals
release their admission; unknown fork outcomes still retain ownership.
