> Historical pre-implementation proposal. See [golden-build-jobs.md](golden-build-jobs.md) for the implemented contract and explicit recovery limits.

# Separate follow-up: durable authenticated golden build jobs (PROPOSED, NOT IMPLEMENTED)

## Evidence at 712bc3ead775a1b715ce142882206069e75c9266
- Reported production baseline: 295s; client disconnected after 270246ms.
- Both createGoldenRoute and updateGoldenRoute await GoldenCreateService.create.
- CLI create/update: explicit 600s AbortSignal; dashboard proxy: 660s;
  Next route declares maxDuration=800.
- SSH subprocess has a 600000ms deadline; full scan now sends 600s, Boat's
  documented maximum. SDK 1.13.0 serializes timeoutSeconds unchanged.
- waitSnapshot allows 1800 polls with 1000ms sleeps, plus provider call latency.
  Thus even valid phase budgets cannot fit a single 600/660/800s HTTP lifetime.
- buildId in GoldenCreateService is a log correlation UUID only, not a job.
  golden_backend_slots.build_id is a capacity reservation UUID, not durable
  execution/status state. Neither is a recoverable queue.
- Current last-good protection: config/pointer update and reservation finalization
  share a SQL transaction; rebuild locks row and compares the old pointer.
  Artifact deletion requires confirmed non-reference after ambiguous persistence.
- timeout:false candidate eliminates a competing Bun idle timer only; it cannot
  solve the end-to-end lifetime mismatch. No timeout increases or blind retries.

## API contract
Separate additive API, not a silent change to synchronous create/update responses:
POST /api/v1/golden/builds/start -> 202 after durable transaction commit.
Input: operation create/rebuild, existing validated config, target identity and
client-generated idempotency key. Scope uniqueness by authenticated owner/org.
Canonical request digest mismatch for same key -> 409; exact replay returns the
same job, never creates another builder. Persist the key before first submission
so an ambiguous acknowledgement can be recovered by key lookup, not a blind retry.

POST /api/v1/golden/builds/status -> short authenticated response by job ID/key.
Public status: queued, running, recovery_required, succeeded, failed; allowlisted
phase/failure code, timestamps and terminal golden identity. No raw provider error,
commands, setup text, environment, tokens, credentials or internal backend IDs.
Unknown/inaccessible jobs have indistinguishable not-found responses.
Authorize every lookup with current membership and golden visibility: org members
may see org jobs, private jobs only owner; job IDs are not bearer capabilities.
Admission and execution enforce the existing mutation rules (org admin/private
owner), not roles copied into queued JSON. Worker resolves current credentials
server-side and rechecks visibility, backend binding and membership before work.

## Storage / worker contract
New migrations only, generated types, explicit grants/RLS. Durable job record:
immutable requester/org/visibility/operation/provider/target + expected revision;
payload digest, encrypted payload if it contains arbitrary setup scripts, state,
safe phase/code, lease/fence/owner timestamps, deadline, artifact receipts and
idempotency key. No bearer or provider key persists in payload.
Store payload separately from selectable status fields; use existing encryption,
never introduce plaintext setup storage or user-JWT ciphertext access.

202 means durable admission, not merely an unawaited Promise in a request handler.
A server-owned worker loop (independent of HTTP lifetime) claims queued work
transactionally; multiple instances must not both claim it. Bounded phase/job
budgets remain. Shutdown stops claiming; worker/restart reconciliation owns
in-flight receipts and capacity slots.

Never implement automatic lease-expiry restart of side-effecting build steps:
a timed-out provider request or expired lease does not prove the old command died.
Persist operation intent before external calls and correlated receipts afterward.
Provider builder creation must use a stable idempotency key if supported and
verified at the SDK boundary. Uncertain external outcomes enter recovery_required.
Do not publish or create a second builder until the old attempt is reconciled.
A DB fence alone cannot cancel an old SSH process; recovery must stop/reconcile
the old builder, verify receipts, or leave an operator-visible recovery state.

Transactionally verify worker fence, current authorization, expected golden revision,
full successful scan receipt and ready correlated snapshot before updating golden
config/pointer, finalizing capacity and marking job succeeded. A crash between
pointer commit and job completion must be impossible (same transaction).
Never clear an uncertain slot or delete an artifact when a committed reference
cannot be ruled out. Recover success from committed receipts; do not rerun scan,
checkout or snapshot blindly. Failed jobs retain last-good config/snapshot.
Cleanup is durable/retryable separately, records only safe codes and retains
artifacts on unknown DB outcomes. No raw errors in status or worker logs.

CLI submits once, prints job ID promptly, then polls bounded short status requests.
A local wait deadline stops polling, not the build; reports job ID and explicit
resume/status command. Status polling failures never resubmit the build.
Add both job paths to dashboard allowlist; MCP should expose the same job contract
rather than retain a separate long-running reliability story.
Do not remove old endpoints until explicit client compatibility/migration work.

## Independent merge and validation gates
1. Existing scan-boundary PR first: no queue/migration dependency.
2. Separate async-job PR: schema/RLS, worker lifecycle and recovery, API/proxy/MCP,
   CLI acknowledgement/poll/resume. Do not advertise reliability until all exist.
3. Real SQL/concurrency tests: atomic claim, duplicate admission, payload conflict,
   private/org visibility, role revocation, atomic publish + job success, stale fence,
   crashes around external intent/receipt/persist, reservation and cleanup recovery.
4. Fake clock/deferred provider tests: disconnect during build doesn't cancel job;
   bounded polling resumes same job; lost acknowledgement can't duplicate work;
   unknown provider outcome cannot publish or replay; failed scan retains old config.
5. Retain real Boat adapter/SDK request serialization regression and full binary,
   filesystem and git-object scan tests. No permissive Provider-only substitute.
6. No production migrations/rebuilds until separate review, green CI and deployment.
