# Durable golden build jobs

Golden create/update return HTTP **202** and a durable job receipt, not an inline
snapshot. Admission checks current membership/mutation rights, locks the expected
rebuild revision, reserves verified Boat capacity/binding and inserts an encrypted
job in one transaction. HTTP handlers do not start builders.

## Clients

POST /api/v1/golden/create or /api/v1/golden/update with the existing payload plus
idempotencyKey (16–128 letters/digits/underscores/hyphens). Save the key **before**
submission. Same requester/org/key and request return the same job; changed input
with that key is a 409. A different key cannot bypass pending capacity.

POST /api/v1/golden/build/status with {jobId}, or recover a lost admission receipt
using {org, idempotencyKey}. Every read authenticates and checks current membership.
Private jobs are owner-only, including against admins. Jobs targeting a now-private
golden are not exposed to other members. Status includes only jobId, state, safe
phase/errorCode and terminal public result, never payload or provider errors.

MCP golden_create/golden_update require idempotencyKey and return the same receipt;
poll golden_build_status. The dashboard uses short admission/status actions,
records the job ID in its URL, and polls sequentially for a bounded local window,
then offers manual refresh.

CLI create/update print the admission key and job ID, then poll short requests.
--timeout 0..600 is the local wait only (default 60s), not worker execution.
Each request has a 10-second AbortSignal; timeout:false disables Bun's independent
idle timer. Poll failures never resubmit builds. Resume with:

    armada golden build-status <job-id>
    armada golden build-status --idempotency-key <saved-key> --org <org-id>

## Worker and atomic publication

armada-server owns a tracked, awaited worker loop independent of HTTP requests.
Claims use FOR UPDATE SKIP LOCKED, a unique fence, renewable 60-second lease and
fixed 60-minute job deadline. Heartbeats cannot resurrect expired leases. The job
ID is the buildId in existing allowlisted phase/failure logs.

Execution resolves current credentials, revalidates membership/role and verifies
the admitted provider account. Every phase checks ownership. Publication locks
the job/current membership, checks expected golden snapshot/owner/visibility,
updates config + snapshot, finalizes binding and marks job succeeded **in one
transaction**. The prior snapshot stays retained. The full filesystem/binary/
git-object scan is unchanged, fail-closed at Boat's documented 600-second maximum.

Failures expose errorCode build_failed. A confirmed HTTP 400 from an unaccepted
Boat snapshot save exposes the closed `provider_snapshot_rejected` reason with
owner retry guidance; local validation errors do not claim a provider rejection.
Accepted saves with unreadable provenance retain capacity as recovery_required.
Modal snapshot failures retain their conservative uncertain-outcome handling.
See [Boat snapshot rejection](diagnostics/boat-snapshot-rejection.md).

Confirmed builder stop (or denial before
any builder request) permits releasing only this attempt's pending reservation,
retaining the existing binding and last-good config/snapshot. Existing ambiguous
persistence artifact-reference checks remain in force.

## Restart and uncertainty

Expired work becomes recovery_required, never queued again. No builder creation,
checkout, scan or snapshot is blindly replayed. Reconciliation can stop a known
builder on the verified original account, then transactionally release its pending
reservation and mark failure. Reconciliation never deletes snapshots. A committed
pointer and job success share one transaction, so lost success receipts are read
back through status.

If builder creation succeeded but the process died before recording the ID, or
credentials/account identity can no longer be verified, recovery intentionally
retains capacity/artifacts for operator inspection. Do not clear the reservation
until the original outcome is reconciled. This is conservative bounded recovery,
not an exactly-once external-execution claim. Worker shutdown stops new claims;
hosts may await the tracked worker task to drain; terminated processes lose leases.

## Deployment

Apply migrations in filename order, including
`20261111080000_golden_snapshot_failure_reason.sql` (after the prior failure-reason
constraint migrations), before deploying the server that writes
`provider_snapshot_rejected`. RLS is enabled; only service_role
has table grants. Arbitrary setup/config payloads use existing AES-GCM encryption.
User JWTs cannot read ciphertext or mutate jobs. Allow the additive status route
through the dashboard proxy.

Old synchronous clients must upgrade: create/update no longer promise an inline
snapshot. No HTTP/proxy timeout is increased. The original proposal is preserved
in [async-build-contract.md](async-build-contract.md).

No production migration/rebuild/deployment is part of this change.

## Operator recovery of the historical Boat billing incident

There is **no owner/admin force-release API or CLI command**. Missing builder
metadata does not prove a refusal: a timed-out allocation can still create a
machine. New ambiguous builds always retain their reservation.

Migration 20261110220100_legacy_boat_payment_recovery.sql captures eligibility
only for already-existing Boat creates in recovery_required/builder with no
builder, snapshot, golden or recorded reason. Later jobs default ineligible,
even with identical metadata. Nothing is automatically released.

For staging incident **aa2f54f7**, after migrations/server rollout:

1. Obtain the full UUID from the first create receipt (the prefix is not a UUID).
   Verify the matching original diagnostic proves golden_build_failed,
   phase=builder, code=payment_required, with no allocation. Present billing
   status, an empty golden list or an absent builder ID is not sufficient.
2. A trusted database operator connected to **staging** using its normal
   service-role/database-owner access runs this transaction with that full ID:

       begin;
       select public.reconcile_legacy_boat_payment_refusal(
         '<full-uuid-beginning-aa2f54f7>'::uuid,
         'provider_payment_required'
       );
       commit;

   The invoker-security function is executable only by service_role (and the
   database owner), never a user JWT. It rechecks migration-captured eligibility
   and current resource/state guards under a job lock, atomically releases only
   that pending reservation, and records failed/provider_payment_required.
   Repeating a completed confirmation is read-only.
3. The owner runs:

       armada golden build-status <full-job-uuid> --json
       armada golden create smoke-boat --provider boat --org <staging-org> --config <same-config> --timeout 600

   Expect the old job failed with failureReason=provider_payment_required
   (build-status exits 1 for terminal failure). Retry with a fresh admission key;
   the old reservation must no longer block creation.

No golden ID is needed. Do not expose this function through the control API or
use an attestation to release a post-migration ambiguous job.
No staging/production database operation is performed by this PR's agent.
