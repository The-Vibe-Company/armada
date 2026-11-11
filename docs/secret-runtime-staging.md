# Application-secret runtime gates (#956)

**Raw application-secret delivery is disabled on both providers.** The vault and
readable-variable transports do not establish secret-safe sandbox delivery. This
work must not be deployed as an opt-in secret-delivery feature.

## Small-PR delivery order

1. Durable irreversible sandbox taint and preservation/reuse refusals. No hydration.
2. Golden provenance and irreversible connect invalidation; fresh-builder attestation.
3. Owner-only interiors, including service selectors, RPCs, direct JWT grants,
   mutation responses and administrative projections.
4. Server-held encrypted redaction context, fixed expiry, sink inventory and
   known-value filtering on events **and non-event state writes**; child text
   refusal. No raw delivery until all consumers fail closed without context.
5. Admission epochs/leases, revoke/rotate denial and retryable confirmed cleanup.
6. Confidential provider transport and final-start hydration, gated on accepted
   provider-specific staging evidence. Explicit launch opt-in comes last; template
   secret bindings/grants remain a separate slice.

Each PR must state which named design tests it actually implements, not claim the
entire design proof matrix passes. #956 remains incomplete until the complete
runtime contract and named tests pass. No migrations are applied by this workflow.

## Coordinator staging canaries (not run by this change)

Use disposable staging organizations on **Modal and Boat**, random synthetic
canaries and no production credentials. Test names refer to
[the merged design](design/templates-variables-secrets.md).

- Preservation/reuse: durably taint before attempted hydration; fail hydration,
  restart control, then stop/expire/delete. No collector, archive export, recovery,
  resume or physical fork may run. Stop/delete must still terminate compute and
  return a value-free warning that unpushed work was not preserved.
- Golden eligibility: connect, write an arbitrary canary, reconnect/restart and
  attempt snapshot; reject. Fresh isolated recipe rebuilds alone become eligible.
- **B1-owner-interior**: owner succeeds, peer/admin denied on every interior route,
  service selector, RPC and direct JWT query; admin stop/delete gives no interior.
- **B1-publisher-risk-probe**: a harmless publisher-controlled PATH shim demonstrates
  that owner-only interiors do not hide a delivered value from golden publishers.
  Boat uses an isolated provider-conformance harness only while delivery is off.
- **B2-hostile-ingest** (Modal): bypass producer filtering with a valid ingest grant,
  submit exact/escaped/multiline canaries, replay an edited local journal, and
  inspect actual persisted rows and every DTO/webhook/export.
- **B2-boat-read**: exercise logs/wait/outcome/notifications/exports; separately
  inspect provider raw event storage. Read-time filtering does not delete it.
- **B2-state-write-canary / R2-S1-metadata**: inject via task outcomes, URLs,
  lifecycle/preservation reasons, usage and orchestrator journals; inspect actual
  rows, mutation echoes, administrative lists and direct JWT column access.
- **S1-context-expiry**: injected-clock expiry, audited context reads/purges,
  tombstones and restore admission denial; no replay after context expiry.
- **S2-child-prompt**: reject registered parent values before persistence/allocation
  through both scoped gateway and tools; no inherited bindings or stale authority.
- Transport/execution: capture provider requests and exec journals; canaries absent
  from argv, metadata, checkout, pull/init and unrelated exec. Only the intended
  harness and its workload children receive values at final start. Race revoke
  against hydration; refusal must win or cleanup must confirm termination.

A failing canary leaves the capability disabled. Modal needs accepted evidence
for confidential private-runner requests, server-side ingest filtering and all
lifecycle gates before enablement. Boat additionally needs documented event and
transcript retention/access, a verified deletion mechanism, residual-copy/backup
policy, staging proof and explicit owner acceptance. **Request-journal exclusion
alone cannot lift Boat's gate.** If deletion evidence is unavailable, Boat remains
broker-only for application access. No environment flag may substitute for proof.

## What is not protected

No current raw-secret end-to-end protection is claimed. Known-value masking is
only defence in depth: encodings, transformations, screenshots, files, commits and
network exfiltration can evade it. A receiving agent, its children, same-UID/root,
provider-key holders and environment publishers may read plaintext. Owner-only
routes are not publisher isolation. Deletion does not erase delivered/provider or
backup copies; upstream rotation is required after exposure. Retained redaction
copies require the design's disclosed 30-day bound and approved backup policy.
Existing model credentials are separately managed. Readable values are not secrets.

## First gate implementation and rollout boundary

The first gate adds `20261111120000_application_secret_taint.sql`. The service-only
`application_secret_tainted` flag is irreversible. Setting it removes existing
online recovery rows; a database trigger refuses subsequent recovery writes.
Preservation checks the durable marker before contacting compute. Recovery reads
join the sandbox marker, and the existing physical-resume hooks refuse retained
secret-tainted disks. There is no hydration endpoint and no client can set taint.

This is **not yet a concurrency-safe secret admission protocol**: a collector or
resume already in flight must be fenced by the later shared lifecycle lease
before any hydration can be enabled. Snapshot provenance, owner-only access,
redaction, revocation cleanup and provider evidence remain separate unimplemented
gates. Do not test hydration against this first gate alone.

Apply the migration before deploying matching server code; old servers must not
serve tainted machines. Dropping the column loses permanent exposure history and
is not a safe rollback. Disable affected workloads and retain taint tombstones
before any rollback/restore. The migration deletes online recovery ciphertext
for tainted machines, not backups or provider disks/events; no erasure claim is
made for those stores. This PR applies no migration and deploys nothing.
