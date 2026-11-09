# Orchestrator lifecycle (#663)

Status: integration candidate, **not enabled**. Ordinary workers retain their
existing launch, model, TTL and retention behavior. This code does not allocate a
production provider, issue live grants, enable a backend, or deploy a migration.
A synthetic test is not provider-native conformance.

## Actual dependencies and ownership

The child service consumes `OrchestratorAuthority.admit` from #661, both for the
atomic receipt reservation and again immediately before dispatch. The inspected
candidate's authority, operation and migration208 bytes match committed #673
`026babbf165a11148f5e274e20d7f2941b73e253`. The current delivery base is origin/main `1eaaf07d5fa9b6380587dec79e98453fc09a2ea0`, which contains #673, named-account #612 and sizing #658.
`generation` in this consumer means SQL `lifecycle_generation`, **not** the
provider's native `physicalGeneration`. Stop receipts bind both independently.
The producer's outstanding native/SQL generation binding mismatch must be fixed
before enablement; never cast one to the other.

`LifecycleRuntimeStore` extends the actual #662 store. An outer SQL transaction
includes the producer's event/cursor acknowledgement and activity receipt; a
crash cannot advance history while omitting its meaningful activity. The actual
shared HTTP/MCP `callOrchestrator` caller uses the composed runtime. Owner message
publication and successful resume retire/reset the lifecycle observation in that
same transaction. Old stop operation receipts remain in the foundation ledger.

Child launch calls the existing `launchSandbox`, uses the reserved sandbox UUID
and operation ID for provider correlation, and binds the child relation before
any prompt. Actual #612 (`af8a9c2`) named account resolver ID/version and persisted
binding are mandatory. Missing202 schema or a legacy resolver fails before fork;
wrong persisted billing identity fails before prompt. No account schema is
reimplemented. Incomplete #604 private-state delivery is **not** advertised as
supported. Child harness/account selection is independent of the parent.

Dependencies are validated only in isolated checkouts under `.git`; their files
are not copied into this focused delivery branch. Final integrated types must be
regenerated after the producer schemas land.

## Decisions and invariants

- Idle defaults to7200seconds, owner-configurable900–86400. There is **no** default
  child concurrency limit, daily start count, Boat quota polling or allocation
  freeze. Only an explicitly owner-configured active-child limit is enforced.
- Reserve immutable org/owner/parent-generation/epoch/correlation before provider
  I/O. Retries return the same receipt; changed payload conflicts. Uncertain
  allocation never automatically forks again. Exact receipt discovery reconciles
  it; absence is not proof of non-allocation. Locally proven preallocation failure
  and the SDK's explicit nonmutating refusal release the reservation as failed.
- Child operations have independent receipts and do not invalidate an admitted
  owner operation's revision. Owner wait/settings changes reject a pending owner
  operation under the same parent lock.
- Read/log polling and duplicate native events do not update activity. Native
  prompt/tool/message evidence, admitted owner actions and known child work do.
  Missing or unknown runtime/native identity is never quiescence.
- Waits use a trusted evidence registry, not arbitrary URLs. Evidence must be
  fresh, correlated and changed on renewal. Expiry is at most15minutes and the
  original absolute deadline at most24hours. Re-registration cannot reset it.
  Exhaustion blocks/revokes admission visibly without stopping active work.
  Fresh confirmed completion remains possible after the cap; it does not silently
  regrant authority or extend consent.
- Two confirmed-quiescence observations and the full idle interval are required
  before idle stop. Pending/uncertain operations, children or unresolved waits
  prevent it. Row leases, logical revision, SQL generation, exact provider ID and
  native physical identity fence delayed results and stop/message races.
- Provider hard TTL and bounded authority epoch expiry are separate from idle.
  Drain begins10minutes before either. Interrupted/unknown/lost checkpoint
  outcomes publish blocked/unverified or lost continuity, never native success.
  No `Provider.resume` API or indefinite TTL is invented.
- Stop closes admission before any checkpoint effect. The runtime must revoke
  and compare-scrub the private epoch before checkpoint. A lost response retains
  the exact durable stop receipt; reconciliation is read-only, not another stop
  or allocation. No logical conversation/history is deleted.
- The ordinary TTL lane excludes managed parents so it cannot bypass the
  orchestrator checkpoint policy. Foundation retention excludes them too.
  Children retain ordinary-worker retention. Removed-owner cleanup must use a
  trusted exact retained-machine backend, never revive removed user authority.

## Remaining producer ports / activation blockers

#662 must provide the actual correlated checkpoint/stop result and read-only
receipt lookup, admitted prompt-ID observation, verified no-text rollover/native
continuation, and trusted removed-owner backend resolution. Its current void
`checkpointAndStop` is not native proof. Owner settings/wait dispatcher callbacks
also need to be wired into the actual shared API; helpers are not a completed
editable-idle/wait API. Actual epoch/private-generation correction and named
account/sizing producer integration remain prerequisites. New optional SDK
private transport methods must not be mistaken for Boat support or hot reload.

Apply reviewed account202, foundation208, lifecycle209 and runtime210 before
starting server code that uses them; regenerate final combined database types
and deploy with the feature off. Only the root integrator owns that sequence.
Rollback disables/revokes admissions and retains identities, receipts and native
state; it does not drop tables or bulk-delete user resources.

## Verification and opt-in native postflight

Synthetic migrated PGlite/service tests cover receipt-before-allocation, uncertain
retries, scoped child control, real ordinary-launcher binding, owner-admission
races, event/cursor rollback, meaningful-activity dedup, bounded waits/cap
completion, idle stop, stop/resume/second stop, physical-identity mismatch,
continuity publication and managed-parent/ordinary-worker separation. Real
PostgreSQL concurrency and actual provider/native proof are separate requirements;
serialized PGlite is not row-lock conformance.

`scripts/orchestrator-native-conformance.ts` is an **operator-only supplemental
API postflight**, never run by verification or by this implementation session.
It refuses before mutation unless the operator explicitly opts in, supplies a
fresh owned nonproduction fixture, a matching approved HTTPS origin and an owner
session, and the server reports native enablement. It never allocates/deletes a
fixture or references an old Modal App. Operator-run it only after independently
reviewing actual SDK checkpoint/native state, private transport ACK/scrub and log
redaction proof for the exact provider/harness/version matrix entry.

The fixture JSON fields are `origin`, `orgId`, `ownerId`, `orchestratorId`,
`childId`, `provider`, `harness`, `createdAfter` (within the last hour),
`environment: "nonproduction"`, `nativeProofReviewed: true`, and the actual
configured `probeToolName`. The detail must prove owner/provider/harness/new
creation and recorded child ownership. There is no default account/app/fixture.
The operator supplies `ARMADA_TOKEN` on the host, not in fixture JSON or argv;
no credential goes into an agent prompt or capture.

After operator approval, the explicit invocation is:

```sh
ARMADA_ORCHESTRATOR_NATIVE_CONFORMANCE=operator_verified_new_owned_nonproduction_fixture \
ARMADA_CONFORMANCE_ORIGIN=https://approved-nonproduction-origin.example \
  bun scripts/orchestrator-native-conformance.ts /path/to/approved-fixture.json
```

The runner checks a successful exact scoped-tool call after minute15 in the
same native turn, quiescent owner stop, actual no-text resume with the same
conversation/logical machine, and a supplemental native-context challenge.
Native SDK/checkpoint proof and log/secret inspection remain independent: a
transcript replay or remembered marker alone never proves native continuation.
Current disabled/missing adapters must fail; no passing run is claimed here.

## Current shared wiring boundary

The rebased delivery branch inherits reviewed producers from actual `origin/main`
`1eaaf07d5fa9b6380587dec79e98453fc09a2ea0`; no producer ownership is copied as a
feature change. Exact #673 head also has its own detached committed checkout under
`.git/663-dependencies/committed-673`. Runtime #662 remains an isolated source
contract, not main integration. Private combinations merge only its actual deltas
onto current main; wholesale old shared files must not erase sizing, invitations
or snapshot-retirement contracts.

`startServerWorkers` preserves main's fourth snapshot-retirement argument;
optional managed lifecycle lanes are the **fifth** argument. `startServer`'s
trusted orchestrator factory receives the same SQL/provider registry and supplies
`runtime`, `lifecycleWorker`, and `childWorker`. No environment flag enables it.

Child selection now consumes actual `LaunchRequest["size"]` and core
`parseMachineSize`; the override is included in the idempotency digest and
forwarded unchanged to ordinary `launchSandbox`. Core owns the selected-repository
> golden default and explicit-override precedence. This module adds no size policy,
quota, default concurrency or provider historical-event repair.

## Explicit dependency and delegated-wait boundary

File presence is not a production migration/application claim. On current
`origin/main` the exact inventory is: **202 present, 203 absent, 208 present**;
**209 belongs to this branch**, and **210 exists only in the actual #662
runtime candidate/isolated dependency combination**, not main. Current sizing
migration 206 does not stand in for missing 203. The root integrator must provide
and review the actual 203 dependency and its compatibility with 202/208/209/210;
this consumer neither recreates it nor assumes schemas compose additively.

Delegated wait mutation remains unsupported by the committed authority producer.
The exact requested producer port is `admitWait(token, { action, kind, reference },
reserve)` with actual `DelegatedOrchestrator`, current grant/membership/parent and
separate SQL/native generation checks held through SQL-only reservation. Unknown
fields/actions, URLs, client-claimed completion and read-only mutation must deny.
The proposed explicit `work:wait` permission requires #661/root-reviewed consent
and a new schema extension if needed: it is not an existing supported scope, no
consumer cast is used, and applied 208 must not be edited. Source/evidence is
inspected outside SQL and reauthorized before persistence, never via a forged
owner `Caller`, token renewal or heartbeat-only lease extension.

Uncertain allocated workers can settle as failed only when read-only discovery
positively confirms closure of the exact provider resource already bound to the
owned reservation. A different resource, missing closure evidence, or a
contradictory no-allocation claim keeps the outcome uncertain. This releases an
explicit owner concurrency reservation only after confirmation, never by quota
polling, absence, another allocation or stopping an unrelated resource.
