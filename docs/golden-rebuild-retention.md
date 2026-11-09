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
Known fork/connect/build dependencies protect their exact input/output revision,
not every older handle on that golden: a build consuming current C must not
prevent retiring older A and exhaust the saved-snapshot quota. Unknown legacy
references, unknown reservations and snapshot-writer fences remain conservative.
New admissions explicitly distinguish a known null input from legacy unknowns.
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
or authorize raw Image deletion. Other live saved handles sharing the same
underlying artifact are references too; retiring one alias cannot reclaim the
current alias's artifact. No provider-specific raw deletion is added.

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
Boat builds cannot distinguish a personal key from org fallback and are retained.
Private Modal histories are eligible only when canonical persisted
`SavedImage.managementAuthority`, exact binding/source/artifact and the current
source principal agree; absent/changed authority stays deferred. Cached optional
info is never substituted for missing canonical image or authority metadata. New publications retain explicit authority,
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


## Controlled rollout: migration 204 is not rolling-compatible

**Integration-owner runbook only. The implementation agent does not execute these
steps against production.** Do not allocate a QA box/VM or start/stop a user VM
for this rollout. Only piggyback a separately root-authorized actual provider
matrix if one is naturally available; the local PostgreSQL/SDK regressions are
not permission to create production resources.

The deployed old writer uses `INSERT golden_operation_fences(golden_id)`.
After 204, its omitted expected snapshot/master become NULL. On an existing
ready canonical golden those differ from the real pointers, so admission rejects
with SQLSTATE **23514**, `Golden revision changed`. This is intentional and must
not be worked around by dropping a trigger or accepting NULL expected revisions.
A health/version response alone does not prove writer/schema compatibility.

1. Establish a **controlled new-admission hold across every origin and MCP/control
   surface**, including direct backend access. Hold golden/launch/restore/snapshot
   and other new allocation-capable admissions and operator mutations. Existing
   user VMs must not be stopped, interrupted or deleted to obtain quiescence.
2. Drain/stop **old Armada application writer and worker replicas**, not provider
   VMs. Positively settle their in-flight SQL/provider requests or retain their
   unresolved durable ownership. Stop new queue claims/reconciliation ticks.
   Inventory queued/running/recovery work read-only; preserve every legacy unknown
   fence/job/reservation. Neither lease age nor expiry is settlement evidence.
   Do not clear/quarantine records merely to make the rollout appear drained.
   Recovery fix #631 belongs to its separate lane and review, not this migration.
3. Keep worker scheduling held through validation of the new writer. `armada
   serve` starts background lanes alongside HTTP: **an ingress hold alone is not
   a worker hold or writer-only mode**. The integration owner must use an approved
   process/deployment hold or prove there is no runnable allocation/recovery work
   during boot/postflight. If that cannot be established, keep the hold and defer
   cutover; do not manufacture quiescence with DB clearing or VM lifecycle calls.
4. Record the approved code SHA and SHA-256 of the exact reviewed
   `20261110120400_golden_snapshot_retirement.sql`; apply those exact bytes with
   the approved migration connection. Do not print credentials or place them in
   argv. No old writer/worker may remain active against 204.
5. Deploy the compatible new writer while admissions/worker scheduling remain
   held. Preserve `expected_snapshot_id` **and** `revision_known` in build-job
   INSERTs when integrating #631. New fence INSERTs carry expected snapshot,
   expected master, known-reference marker and operation kind.
6. Capture and verify the installed SQL definitions/hashes and enabled triggers
   against the reviewed DDL. For example, using the approved operator SQL session:

   ```sql
   SELECT p.oid::regprocedure AS signature, pg_get_functiondef(p.oid) AS definition,
          md5(pg_get_functiondef(p.oid)) AS definition_md5
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN
     ('lock_golden_snapshot','guard_golden_revision_admission',
      'guard_retired_golden_snapshot','guard_golden_publication_proof',
      'guard_golden_retirement_barrier') ORDER BY 1;
   SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition
   FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
     ('golden_revision_admission','guard_retired_golden_snapshot',
      'golden_publication_proof','golden_retirement_barrier','goldens_provider_guard')
   ORDER BY tgname;
   ```

   Keep the exact definitions and hashes as the release receipt (MD5 here is only
   an audit checksum, not authentication). Verify expected definitions rather than
   blessing whatever production returns. Account for PostgreSQL rendering-version
   differences explicitly. The compatibility alias guard, source admission guard
   and immutable provenance/barriers must all be enabled for the writer session.
7. Run a **rollback-only SQL admission postflight**, as the actual server writer
   role, using an existing non-removed golden with a non-null ready canonical
   snapshot. Replace only the placeholder ID; never start/fork/stop any provider
   resource for this check. Record fence counts before/after to prove no ownership
   was persisted or cleared. This does not clear pre-existing unknown fences.

   ```sql
   BEGIN;
   SELECT set_config('armada.retirement_postflight_golden','OPERATOR_GOLDEN_UUID',true);
   DO $$
   DECLARE g record; fence_id uuid; message text;
   BEGIN
     SELECT id,provider_snapshot_id,provider_sandbox_id INTO STRICT g
       FROM public.goldens
       WHERE id=current_setting('armada.retirement_postflight_golden')::uuid
         AND removed_at IS NULL AND provider_snapshot_id IS NOT NULL;
     INSERT INTO public.golden_operation_fences
       (golden_id,expected_snapshot_id,expected_sandbox_id,revision_known,operation_kind)
       VALUES(g.id,g.provider_snapshot_id,g.provider_sandbox_id,true,'launch')
       RETURNING id INTO fence_id;
     IF fence_id IS NULL THEN RAISE EXCEPTION 'Compatible admission was not recorded'; END IF;
     BEGIN
       INSERT INTO public.golden_operation_fences(golden_id) VALUES(g.id);
       RAISE EXCEPTION 'Legacy admission unexpectedly accepted';
     EXCEPTION WHEN check_violation THEN
       GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
       IF message<>'Golden revision changed' THEN RAISE; END IF;
     END;
   END $$;
   ROLLBACK;
   ```

   Require modern admission success and old-writer rejection for the intended
   reason. Any mismatch keeps the hold in place. No postflight transaction commits.
8. Release admissions and normal compatible worker scheduling only after every
   serving writer/worker is on the approved compatible code and postflight passes.
   Historical cleanup remains a separate owner/admin dry-run, exact receipt review
   and explicit reconcile confirmation. Current/tombstoned pointers and unknown
   ownership remain protected; no automatic historical backfill runs on deployment.

If application rollback is needed after 204, keep admissions held and roll forward
a compatible writer/repair. **Do not roll only the old application back under the
new schema**, relax admission, erase namespace/provenance, clear unknown jobs or
remove sealed barriers. A database rollback/removal of safety state requires a
separate integration-owner plan and review; it is not a routine release fallback.
