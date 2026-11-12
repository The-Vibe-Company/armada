# Application-secret runtime gates (#956)

**Owner override (#1037): template-bound raw secret environment delivery is enabled
on both providers using the existing readable-variable transport.** See the
authoritative [template staging checklist](templates-staging.md#secret-bindings-1037).
The owner explicitly accepts raw values and ordinary sandbox lifecycle behavior;
the hardening plan below is deferred, not a delivery prerequisite. The transport
does not promise secret-safe recovery, retention, redaction or erasure. Existing
taint gates remain for already-marked sandboxes; template delivery adds no taint.

## Small-PR delivery order

1. Durable irreversible sandbox taint, SQL preservation/recovery refusal, prompt
   resume gates and blanket ordinary exec refusal for tainted machines. No hydration.
2. Taint-aware provider retention/reuse fences: deny Modal stop recovery images
   and managed Boat parent recovery/fork; propagate taint to provider boundaries.
3. Golden provenance and connect invalidation: only attested fresh-builder
   snapshots eligible; legacy snapshots require rebuild.
4. Owner-only interiors: cover service selectors, endpoints, projections, RPCs
   and direct JWT grants; admin stop/delete remains value-free.
5. Retained encrypted redaction context: audited server-only copies, fixed
   30-day expiry, purge/tombstones and fail-closed replay; no delivery authority.
6. Event/transcript enforcement: trusted Modal pre-ingest and centralized Boat
   read filtering for every consumer, including escaped/chunked values.
7. Non-event sink and child-text enforcement: outcomes, notes, usage and journals;
   reject registered parent values before child persistence/dispatch.
8. Admission/revocation lifecycle leases: taint before hydration, fence concurrent
   collection/resume/admission, immediate revoke denial and confirmed cleanup.
9. Modal confidential final-start transport: no argv/journals/checkouts, only
   the selected harness after init; capability stays disabled pending canaries.
10. Explicit raw-delivery opt-in and provider release gates: only proven providers
    after all prior gates and owner-accepted canaries. Boat additionally requires
    accepted retention/deletion evidence; template bindings/grants remain separate.

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
- First-gate Boat exec canary: on a disposable staging sandbox, have the operator
  set the durable taint flag, keep SQL status `ready` with `stop_requested_at=null`,
  and let Boat stop/archive it through TTL (not Armada stop). Run
  `armada exec <sandbox-id> -- pwd`, and repeat via MCP `exec` and control
  `sandbox/exec`. Expect unavailable, no Boat command-journal entry, no resume,
  and unchanged stopped/archived provider state. No secret value is needed.
  Tainted running sandboxes also refuse exec: this is intentional blanket denial.
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

The first gate adds `20261111130000_application_secret_taint.sql`. The service-only
`application_secret_tainted` flag is irreversible. Setting it removes existing
online recovery rows; a database trigger refuses subsequent recovery writes.
Preservation checks the durable marker before contacting compute. Recovery reads
join the sandbox marker. Ordinary prompt resume hooks refuse tainted disks; all
ordinary exec is denied for tainted sandboxes before native preparation/commands,
including MCP, control API and CLI exec. This blanket denial avoids relying on a
racy stopped/archived state check. Provider-internal recovery is not yet covered:
Modal stop can still create a filesystem recovery image, and managed Boat parent recovery
can bypass ordinary resume hooks. These paths require explicit taint-aware
provider fencing before hydration is permitted. There is no hydration endpoint and no client can set taint.

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
