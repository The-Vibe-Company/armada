# Application-secret runtime gates (#956)

**Raw application-secret delivery is disabled on both providers.** The vault and
readable-variable transports do not establish secret-safe sandbox delivery. This
work must not be deployed as an opt-in secret-delivery feature.

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
racy stopped/archived state check. The provider-retention gate below additionally
covers Modal recovery images and managed Boat parent activation. There is no
hydration endpoint and no client can set taint.

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

## Provider-retention gate enforcement (step 2)

No migration is added. The authoritative marker remains
`public.sandboxes.application_secret_tainted`; no client, model or provider-request
field can opt into or out of this policy.

- **Modal:** production composition resolves the marker from service SQL for the
  exact provider ID and organization, including soft-deleted rows. Native lifecycle
  operations consult this policy before taking/reusing a recovery image. Taint observed
  during stop permanently disables native recovery for that machine. A tainted stop
  persists this downgrade and terminates without runner checkpoint, snapshot
  scrubbing or filesystem snapshot. Active recovery references are removed; old
  image IDs remain cleanup metadata, never restore authority. Repeated stop and
  recreated providers cannot turn that machine back into a resumable checkpoint.
- **Modal authority outage:** unknown policy cannot authorize a snapshot or restore.
  If native state remains writable, a retention-lookup failure makes stop persist
  disabled recovery and terminate without preserving local work, with generated
  warning `application_secret_retention_disabled_disk_not_retained`. This can
  lose unpushed work. A total native SQL outage prevents lease/save and therefore
  prevents provider mutation; termination is not guaranteed in that case. Known native
  disabled recovery stays disabled even if the callback is later unavailable.
  Managed checkpoint-and-stop still terminates compute but refuses to fabricate a
  native checkpoint/session-success receipt; its operation may remain unverified.
- **Boat:** the managed best-effort adapter validates current persisted owner,
  operation, incarnation and taint before calling the cloud-only resume port.
  It cannot reuse an absent/mismatched SQL identity or a tainted disk. No new
  authority, prompt or command is installed after a refused activation. This is
  the trusted managed adapter boundary, not a restriction on provider-key holders
  calling Boat directly. Boat stop can still retain a provider-owned disk; we do
  not claim provider erasure. Its retention/deletion evidence gate stays closed.

Use matching control/provider code on every replica. Older provider code does not
understand the sticky native downgrade; do not roll it back or erase that marker
for affected machines. No runner payload change, migration or new environment
configuration is required; raw delivery remains disabled throughout rollout.

Fresh builder/allocation cleanup may precede registration in `sandboxes`; absence
of a row is not treated as proof of a delivered secret. Golden eligibility is
still step 3. Service-role hard deletion/tampering, direct provider control and
backup erasure are outside these route guarantees. Every supported hydration path
must first register taint durably; no such hydration exists in this release.

## Provider-retention gate canaries

Before accepting step 2 as staging-proven release evidence, the coordinator must
exercise provider-native mutation boundaries with durable taint already committed
(not raw secrets). The automated tests cover these paths with disposable SQL and
fake cloud transport; they do not replace provider canaries:

- Modal ordinary and managed stop must terminate compute without invoking runner
  checkpoint/export, snapshot scrubbing or `snapshotFilesystem`. Repeat after a
  failed termination and after recreating the control service/provider instance.
- An existing recovery image must not authorize a tainted restore, native
  checkpoint replay or fork; verify no allocation and no new snapshot. Old image
  identifiers are cleanup metadata, not permission to reuse a disk.
- Boat managed-parent best-effort activation must reject taint before the resume
  API, including when SQL says stopped and provider state is archived. No prompt,
  command, resume or new managed authority may be dispatched.
- Unavailable authoritative taint lookup must not authorize reuse or a recovery
  snapshot. Non-tainted preservation/recovery retains its existing contract.

These checks do not prove concurrent hydration safety: step 8 must serialize
admission/taint with provider lifecycle mutation before any delivery is enabled.
Boat's provider-owned archives, events and deletion/backup policy remain outside
Armada's erasure guarantee and continue to block raw application-secret delivery.
