# Orchestrator lifecycle (#663)

Status: integration candidate, **not enabled**. Issue #717 remains blocked on the
Boat-native driver described in [orchestrator-runtime.md](orchestrator-runtime.md).
`ARMADA_ORCHESTRATOR_PAIRS` records server deployment intent and exposes per-pair
unavailability diagnostics only; no requested pair becomes enabled. Ordinary workers retain their
existing launch, model, TTL and retention behavior. This code does not allocate a
production provider, issue live grants, enable a backend, or deploy a migration.
A synthetic test is not provider-native conformance.

## Actual dependencies and ownership

The child service consumes `OrchestratorAuthority.admit` from #661, both for the
atomic receipt reservation and again immediately before dispatch. The inspected
candidate's authority, operation and migration208 bytes match committed #673
`79472bf3f68f83ab53692a6655c484c9f9431a23`. The current delivery base is origin/main `e5fc554fd778e021f6c84984e8cee8ac4837ec09`, which contains #673, named-account #612 and sizing #658.
`generation` in this consumer means SQL `lifecycle_generation`, **not** the
provider's native `physicalGeneration`. Stop receipts bind both independently.
The merged authority now binds SQL and native generations separately (migration216
and `OrchestratorAuthority.installEpoch`/ACK/admission). The former mismatch warning
is resolved; never cast one identity to the other. Boat-native observation and
checkpoint/restore are separate unresolved requirements.

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
are not copied into this focused delivery branch. Integrated types are regenerated against the merged producer schemas.

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

Main #704 now supplies the correlated checkpoint/stop and read-only receipt
ports, prompt observation and trusted retained-machine backend selection. Its
managed adapter projects native `physicalGeneration` separately from the SQL
counter. These source contracts remove the prior integration blockers; declared
ports alone are not operator-native proof. Owner HTTP settings/wait routes are
implemented below. Delegated wait admission remains the explicit producer port
boundary described later, without an owner-impersonation fallback.

The reviewed account202/model-auth203/foundation208/runtime215/native-binding216
migrations precede this branch's lifecycle217 migration. Production applies
migrations via CI in version order on merge; do not apply or edit already-main
files here. Combined database types are regenerated. Keep native composition off
until the operator conformance matrix is independently reviewed.
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
`e5fc554fd778e021f6c84984e8cee8ac4837ec09`; no producer ownership is copied as a
feature change. Exact #673 head also has its own detached committed checkout under
`.git/663-dependencies/committed-673-ready`. Runtime #662 is now on main through #704. Private combinations merge only its actual deltas
onto current main; wholesale old shared files must not erase sizing, invitations
or snapshot-retirement contracts.

`startServerWorkers` preserves main's fourth snapshot-retirement argument;
main's fifth maintenance argument is also preserved; optional managed lifecycle
lanes are the **sixth** argument. `startServer`'s
trusted orchestrator factory receives the same SQL/provider registry and supplies
`runtime`, `lifecycleWorker`, and `childWorker`. The default-empty `ARMADA_ORCHESTRATOR_PAIRS` setting diagnoses requested pairs,
but no environment flag can manufacture the missing native backend.

Child selection now consumes actual `LaunchRequest["size"]` and core
`parseMachineSize`; the override is included in the idempotency digest and
forwarded unchanged to ordinary `launchSandbox`. Core owns the selected-repository
> golden default and explicit-override precedence. This module adds no size policy,
quota, default concurrency or provider historical-event repair.

## Explicit dependency and delegated-wait boundary

File presence is not a production migration/application claim. On current
`origin/main` the exact inventory is: **202, 203 and 208 present**;
**217 belongs to this branch**, and **runtime215/native-binding216 are on main**. The root integrator must review migration deployment ordering;
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

## Scoped epoch tool gateway (not the owner dispatcher)

Production wiring now includes a dedicated gateway route in the paired service
bundle, mounted before owner control routes. The trusted server factory provides
`scopedMcpUrl`, constructed as
`PUBLIC_ORIGIN/api/v1/orchestrator-tools/mcp`. Pass this exact value into actual
#662 private bootstrap `backend.mcpUrl` and `createOrchestratorServices`.
Construction rejects the generic owner `/mcp` path, and backend resolution
rejects a different URL before any owner-side SDK action. #662 continues to own
the private compare-install/ACK/scrub adapter; no grant enters URL, argv or files.

The stateless MCP names `launch`, `read`, `message`, `stop` map to actual #661
`worker:launch`, `worker:read`, `worker:message`, `worker:stop`. Each data/effect
call goes through the actual scoped child service/`Authority.admit`, not a forged
`Caller`, owner API dispatcher or generic sandbox API. Initialize/tool-list data
are static protocol metadata, not proof of an authenticated principal. Neither
owner sessions nor service tokens are accepted as epoch credentials here.

Private REST POST `/api/v1/orchestrator-tools/{launch,read,message,stop}` shares
the same strict argument validation. Mutations require the `Idempotency-Key`
header; MCP mutations require the `idempotencyKey` argument. Payloads are read
with a bounded stream. Unknown fields, methods, admin/credential/exec/general
owner actions deny. Repeated MCP/REST mutations share the same durable receipts.

Known proposed `wait_record`, `wait_renew`, `wait_complete` routes return
`admit_wait_not_supported` and are not listed as MCP tools. They will require the
reviewed actual `admitWait`/permission boundary described above; the owner-only
wait service is never used as a delegated fallback. This code does not claim
that the proposed `work:wait` scope exists today.

Child launch executes the actual core launcher directly, preserving selected
repository, optional actual `MachineSize` and idempotency selection. It does not
proxy through legacy owner HTTP. If a remote HTTP executor is supplied, it must
use actual `/api/v1/sandbox/launch-sized-v1` with `sizePolicyVersion: 1` whenever
sizing/policy semantics matter, and must fail on 404 rather than retry legacy
launch. No selected repository means no repository default. Actual #658 source
`ea501bd2a7187fa788b96914c23aa1fe68b4d8b3` remains the sizing contract.


## Corrected historical reader integration (#674 / PR675)

The normal main ancestry now includes
`1fd430a500dcaccf95d9d27f0984918f0dab831e` (source
`42e24a2474e0ebf12b4ad40284a112855573ae4a`). This branch does not modify the
provider reader, sort or deduplicate orchestrator input to conceal its behavior,
or synthesize prompt completion. Raw corrected provider pages remain the input
to the actual runtime publisher.

The integrator reports a read-only production postflight on an existing stopped
Modal Codex fixture: 106 events / 106 unique IDs, pages 100@132 and 6@138,
queued -> running -> finished, `getPrompt` finished, provider stopped, settled
true; receipt `R/modal675-production-postflight.json`. This is root-reported
reader evidence, not a provider operation or independently performed native
conformance by this worker. No VM/model was created and the old App stays
stopped.

Only the historical-reader dependency is cleared. Private grant ACK/scrub,
long-running native turns, stop/restore with the same native conversation,
physical-generation binding, and the remaining 203/runtime/auth integrations
remain activation blockers. Any new actual conformance still requires a newly
owned operator fixture. The implementer does not reuse the old App or enable
production operations from this receipt.

## Owner lifecycle HTTP contracts

The paired bundle now also mounts an owner lifecycle route before the generic
#662 owner dispatcher. It uses actual `authenticateCaller` bearer verification
plus the actual runtime store's fresh private-owner/current-membership SQL.
Epoch grants are rejected before this path; it is not delegated-wait support.
No request-supplied owner, role, generation or parent authority is accepted.
Reads never resolve a provider or activate compute.

- GET `/api/v1/orchestrators/:id/settings?orgId=...` returns version, parent ID,
  revision, effective idle seconds, nullable explicit child cap and idle deadline.
- POST the same path requires `Idempotency-Key` and strict JSON `{orgId,
  expectedRevision,idleSeconds,maxActiveChildren}`. Bounds remain 900–86400;
  `null` removes an explicit child cap. Same-key altered payload conflicts.
- GET `/:id/waits?orgId=...` returns the actual unreleased lease projection,
  including expired unresolved waits rather than manufacturing empty work.
- POST `/:id/waits` requires the key and strict `{orgId,expectedRevision,kind,
  reference,reason,expiresAt}`. The server derives current SQL generation and
  requires fresh correlated registered evidence; lease expiry/cap remains bounded.
- POST `/:id/waits/:waitId/renew` requires `{orgId,expectedRevision,expiresAt}`
  and actual active evidence. POST `.../release` requires `{orgId,expectedRevision}`
  and actual completed evidence. Client release intent is not completion proof.
  Lease kind/reference/reason come from the owned stored lease, not substituted IDs.
  Renewal/release receipts bind the immutable lease ID, action and wire request;
  changing a displayed reason later cannot invalidate an identical retry. Changed
  request fields still conflict, and replay retains fresh owner/member checks.

Mutations serialize under the existing parent fence and reject pending owner
operations. Known invalid/conflict/not-found/unavailable outcomes have safe typed
HTTP errors, not arbitrary provider messages. Authentication failure, stale
membership, other-owner/admin access and epoch-to-owner promotion deny. Replies
and reads use `Cache-Control: no-store`. Owner MCP dispatcher additions remain
#662-owned; these HTTP endpoints and the epoch gateway are separate principals.

## Current main integration and deployment boundary

Main `a7af4a73ea2fda586778fe8994b991a6671f5ddf` (#704) is merged normally.
Its runtime and native-binding migrations215/216 precede this branch's
`20261110121700_orchestrator_lifecycle.sql`. The lifecycle migration was never
applied under its original209 filename; its SQL is unchanged. Combined database
types are regenerated. Never edit an applied main migration.

The prior missing-runtime-module blocker is cleared. Server composition preserves
main's credential/model-auth context and single managed-lane factory, while the
full663 bundle adds authenticated owner lifecycle and scoped epoch routes plus
both lifecycle/child lanes. The sixth worker argument accepts a single lane or
an array; fourth snapshot retirement and fifth maintenance remain unchanged.
No default native backend is added. The later #717 deployment-intent setting
reports native blockers without enabling any backend.

Same-session independent review repaired blocked-parent deadline/removal cleanup
and runtime failure-reason projection; red/green migrated-schema regressions cover
both. Provider-native enablement still requires operator-reviewed private epoch
ACK/scrub, physical-generation binding, checkpoint/no-text continuation and the
nonproduction conformance matrix. Synthetic tests and green CI are not proof of
live provider behavior. Delegated wait mutation remains explicitly unsupported
until the actual authority producer supplies its reviewed admission port; owner
wait/settings HTTP endpoints remain supported. These are feature activation
prerequisites, not a claim that the feature is currently enabled.

## #717 activation decision and rollback

No actual production authority/runtime/lifecycle/child bundle is constructed by
`serve` without the existing trusted factory. This is intentional while the Boat
native driver is missing, not a passing activation claim. The HTTP and MCP
capability diagnostics share the explicit server pair setting; with it unset,
the legacy off response and all ordinary sandbox behavior remain unchanged.
Unset `ARMADA_ORCHESTRATOR_PAIRS` and restart to roll back these diagnostics;
identities and durable history are retained. A future live-runtime rollback also
needs coordinated admission shutdown, epoch revocation and worker drain.

Delegated waits remain precisely unsupported: the actual authority has `admit`
for `worker:launch`, `worker:read`, `worker:message`, `worker:stop`, but no
`admitWait` or `work:wait` scope. The private gateway rejects known wait mutations
with `admit_wait_not_supported` and does not list them as MCP tools. Owner-only
wait APIs are not an authority substitute. Supporting delegated waits needs an
explicit reviewed consent/scope decision, a new migration if required, atomic
SQL/native-generation-bound reservation, and independently verified evidence
before reauthorization/persistence. No applied migration or scope was changed.
The minimal create/chat/stop/resume lane cannot honestly enable until native
continuity is implemented even if delegated waits remain intentionally absent.
