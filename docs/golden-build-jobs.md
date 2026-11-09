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
ID is the buildId in existing allowlisted phase/failure logs and the stable Boat
builder-creation idempotency key (verified through the installed SDK serialization).
This key is correlation/deduplication protection, not permission to blindly replay work.

Execution resolves current credentials, revalidates membership/role and verifies
the admitted provider account. Every phase checks ownership. Publication locks
the job/current membership, checks expected golden snapshot/owner/visibility,
updates config + snapshot, finalizes binding and marks job succeeded **in one
transaction**. The prior snapshot stays retained. The full filesystem/binary/
git-object scan is unchanged, fail-closed at Boat's documented 600-second maximum.

Failures expose errorCode build_failed. Confirmed builder stop (or denial before
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

Apply the new migration before worker deployment. RLS is enabled; only service_role
has table grants. Arbitrary setup/config payloads use existing AES-GCM encryption.
User JWTs cannot read ciphertext or mutate jobs. Allow the additive status route
through the dashboard proxy.

Old synchronous clients must upgrade: create/update no longer promise an inline
snapshot. No HTTP/proxy timeout is increased. The original proposal is preserved
in [async-build-contract.md](async-build-contract.md).

No production migration/rebuild/deployment is part of this change.
