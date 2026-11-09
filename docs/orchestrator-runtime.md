# Persistent orchestrator runtime (#662)

Status: **disabled, integration candidate**. Ordinary workers are unchanged.
The service is not constructed in `serve`; absent services return `unavailable`.
`orchestrator_capabilities` and the authenticated HTTP capabilities route report
`enabled: false`. Neither an injected fake provider nor passing synthetic SQL
checks enables a real provider/harness.

## Actual foundation consumed

The runtime consumer projection consumes committed #661 PR #673,
`026babbf165a11148f5e274e20d7f2941b73e253` (producer base
`648b8cfbbd0df1d527cacdb9e3098af934d2d650`). The exact dependency is checked
out under `.git/662-pr673`; no producer files are copied into delivery ownership.
The earlier uncommitted v1 archive is superseded as integration evidence.

- `reserveOrchestratorOperation(sql, input)` remains the receipt writer. The
  runtime holds the owner/member/parent lock around prior-receipt discovery and
  reservation. Prior pending/uncertain receipts never repeat external effects.
- `OrchestratorAuthority.installEpoch`, `revoke`, `scrubBeforeCheckpoint` remain
  the issuer/revocation boundary. No owner token or browser refresh key is copied.
- Transport `deliver(token, {epoch, physicalGeneration})` must atomically
  compare-install and ACK; `scrub(hash?)` must compare-scrub a single failed
  delivery or quiescently scrub all grants before checkpoint. `configureMcp`
  file delivery is **not** assumed to satisfy that port. The new private Runner
  epoch RPC implements monotonic compare-install and exact compare-scrub; only an
  epoch tombstone is journaled. Modal exposes these operations under an active
  native-generation lease; stopped machines are never restored by this transport.
  Active native turns refuse rotation/scrub; no hot reload is claimed. Checkpoint
  refuses until the slot has been scrubbed. Boat has no implementation here.
- Child `Authority.admit` and lifecycle/waits remain #661/#663-owned; this change
  does not dispatch delegated principals as owners.

The committed producer requires sandbox status `running` during epoch installation,
whereas `launchSandbox` without a prompt leaves `ready`. A producer correction
allowing verified ready admission (with all current fences), or a verified
no-text activation adapter, is required. Do not manufacture `running` state or
send a synthetic prompt to work around this mismatch.

The producer delegation currently calls SQL `lifecycle_generation` its physical
binding. That counter advances on normal activity admission/completion, whereas
Modal's private runner binds the actual native physical generation. These are
not interchangeable. A producer-owned binding correction or reviewed rebind
protocol is required before composition; the transport fails closed on mismatch.
The 24-hour epoch and #663 expiry drain do not justify manual reauthentication or
assumed native-client live rotation.

## Runtime policy and storage

HTTP `/api/v1/orchestrators` and MCP `orchestrator_*` share `callOrchestrator`.
Owner reads require current membership; generic worker routes are fenced by #661.
Mutation receipts bind canonical actor/org/action/target/payload. Create uses a
stable create sentinel and a durable create-key relation before allocation.
Unknown allocation never starts again automatically.

The launcher adapter reuses v2 `launchSandbox`, pins fork correlation to the
operation ID and atomically binds the private parent in the sandbox insert
transaction. Named-account selection must come from #612's actual
`credentialId`/`credentialVersion` resolver, not an MCP connection or a legacy
credential default. Sizing must come from #653's actual `LaunchRequest.size` and
`resolveMachineSize` policy: override, selected repository, golden, legacy.
Those production adapters are not composed here yet. No daily cap or synthetic
Boat quota is added. An optional child concurrency bound is owner-selected.

Proposed additive migration `20261110121000_orchestrator_runtime.sql` depends on
208 and has confirmed exclusive ownership for #662. It owns runtime configuration,
create receipts, durable native events and provider-cursor ingestion. Publication
locks and compares logical revision **and the actual sandbox generation row**.
History reads after stop never activate a provider. Event payloads retain native
text/tool events; this mirror is not a substitute for native checkpoint state.

Detail's waits/delegation/children projection must be supplied by the actual
lifecycle adapter; absence returns unavailable, not fabricated empty work.
Generated database types must be regenerated on the final integrated schema;
no generated #661 source is copied into the focused branch.

## Validation and native enablement

Synthetic checks (run explicitly in the dependency combination):

```sh
bun test ./packages/mcp-server/test/orchestrator-runtime.integration.ts
ARMADA_TEST_POSTGRES_URL=<disposable-test-db> \
  bun test ./packages/mcp-server/test/orchestrator-runtime-postgres.integration.ts
```

The PostgreSQL test observes an actual backend blocked behind the publication
lock. Removing the sandbox row lock makes it fail; restoring the lock passes.
PGlite is used for receipt/privacy/cursor/event behavior, not row-lock proof.

There is **no provider-native enablement proof**. Before enabling each of
Boat/Modal × Claude/Codex, an operator must provide a **new, owned nonproduction
fixture** (never reuse the stopped old Modal App) and a concrete native adapter:

1. Install pinned public skills before the first prompt; record public source SHA
   and fail conflicts without overwriting unrelated directories.
2. Demonstrate private compare-install/ACK and compare-scrub under reordered
   epoch/generation delivery, without grants in prompt/argv/public logs/events.
3. Run a real native turn over 15 minutes, demonstrating successful scoped tool
   calls after minute 15; test revoked membership and stale scope rejection.
4. Quiesce, revoke/scrub, checkpoint and verify the actual provider's native
   checkpoint generation plus durable event ACK watermark. A physical exit or a
   successful void `Provider.stop` is insufficient evidence.
5. Restore **without text**, prove the same native conversation/session from
   saved native state, reject stale generations and lost checkpoints, and then
   send a continuation with the exact original account/model/provider.
6. Verify retained text/tool history after stop, bounded-epoch rollover without
   hot-reload assumptions, and no grant bytes in native/checkpoint/public state.

The existing generic Provider interface has no verified no-text native resume or
checkpoint-evidence method. Runtime backend ports deliberately have no fallback
implementation. A concrete opt-in fixture runner cannot claim success until
those real ports and the private authority transport are supplied and reviewed.
This document is a conformance requirement, not a passing conformance report.

Deploy account migration 202, reviewed foundation 208, then runtime
migration 210 (confirmed exclusively #662) (and #663's independently owned migration if needed), regenerate
combined types, deploy with feature off, and only then review operator proof.
Rollback disables admission/revokes epochs and retains identity/history/native
state. No migration, grant, allocation or deployment is performed by this work.

## Historical event reader dependency

#674 owns the provider SQL cursor-order/pagination correction. Runtime ingests the
provider's ordered pages unchanged; it does not sort or repair history. Require
the corrected provider plus historical pagination/final-state/native-continuity
postflight on a new operator-owned fixture before enabling any matrix entry.

## Current exported private transport ports

`createOrchestratorTransport({provider,providerSandboxId,physicalGeneration,mcpUrl})`
closes over trusted server configuration and implements the exact #673 transport.
Provider optional `installOrchestratorEpoch({sandboxId,token,binding,url})` and
`scrubOrchestratorEpoch({sandboxId,physicalGeneration,tokenHash?})` return private
ACKs; their inputs never become public API fields, argv or replay receipts.

`launchOrchestratorParent` now requires `account` with the actual #612
`credentialId`, `credentialVersion` and four-argument resolver. It probes the
actual named sandbox-binding columns before fork, rejects missing/wrong resolver
bindings, and checks the persisted sandbox binding. `resolveBackend` receives the
existing `RuntimeIdentity` for later turns so production composition must resolve
the stored account/version, never silently choose a new account/default.

The trusted backend must supply `consent` using the exact #673 installEpoch input
(scopes/goldenIds/credentialIds) from actual owner-approved #603 selections.
Runtime does not force that list to the parent's single account/harness, nor
infer permission for all owner accounts. Each child still passes fresh #661
scope/owner/org/golden/account/harness authorization. Production consent/default
resolution remains uncomposed until the actual account producer is integrated.

## Trusted managed stop and #663 caller

The actual #663 source-contracts-v2 archive (SHA-256
`d20be62aed82a960e9812e1f37fc9d0ba2a7d45752bd56dfe423a18adfb745ca`)
is inspected only under `.git/663-source-v2`. No lifecycle implementation/schema
is copied into this delivery. A strict inherited-tsconfig assignment verifies
that `runtime.lifecycleRuntime` implements its actual
`OrchestratorLifecycleRuntime` (`observe`, `stop`, `reconcileStop`), not guessed
method signatures.

`OrchestratorRuntimeOptions.managed` supplies trusted SQL and
`resolveManaged(machine, selection)`; selection is only persisted owner/org,
golden and provider metadata. It must not require a current membership or model
credential to stop already-owned compute. Create/resume admission requires this
cleanup lane. Owner HTTP/MCP stop uses the same native dispatch as the lifecycle
lane (`stopOwner`), after normal fresh owner authorization, and deliberately does
not resolve model credentials. This keeps revoked model access from preventing
compute cleanup; it does not give removed users API access.

`ManagedNativeBackend` requires:

- `observe(machine, signal?) -> ManagedObservation`, correlated native work
  evidence, not a heartbeat/capability flag;
- `checkpointAndStop(machine, operationId, signal?) -> ManagedStopReceipt` with
  the exact #663 operation/machine/generation/state/continuity fields;
- `readStopReceipt(machine, operationId, signal?) -> ManagedStopReceipt | null`,
  strictly read-only: no stop retry, restore or allocation.

The actual208 stop receipt must exist before dispatch. Proposed210 adds only a
safe `runtime_result` projection to that receipt, not a second operation store.
The controller records an uncertain dispatch fence before native I/O, revokes and
compare-scrubs before checkpoint, and saves only correlated safe receipt fields
under logical revision and sandbox-generation locks. Duplicate stop goes through
read-only reconciliation, never repeats the native effect. #663 retains lifecycle
publication/lease ownership; this controller does not publish parent state from a
late receipt. Unverified owner stop/resume clears the native-continuity hint.
Concrete native observation/checkpoint/read-only provider adapters are still
required before enablement; these mandatory ports are not a proof by themselves.

Active parent stop first revokes authority and uses optional private
`Provider.quiesceOrchestrator({sandboxId,physicalGeneration})` (Modal routes this
to the existing Runner interrupt under the active-incarnation lease). A native
observer must then return correlated quiescent evidence before compare-scrub and
checkpoint. An interrupt ACK alone is not quiescence proof. This avoids asking
an active native client to hot-reload/scrub credentials or accidentally restoring
stopped compute through the generic interrupt path. Unknown observations retain
an uncertain receipt and clear the native hint; no checkpoint is claimed.

## Actual lifecycle composition

`createOrchestratorServices` binds actual #663 configure/activity/detail/worker
callbacks and constructs one runtime/store/managed lifecycle bundle. Initial
configuration runs inside identity creation **before** the #208 receipt is
reserved; its actual revision increment is read and respected, never rewound.
Native activity and history/cursor ACK share one transaction, so a callback failure
rolls back both. Replayed event IDs do not become fresh activity. Public activity
metadata reads the actual #209 policy/state; no second lifecycle policy is added.

The optional trusted factory in `startServer` supplies that exact runtime to HTTP
and MCP and adds its `reconcileOne`/`drain` to the existing fair lifecycle lane.
No factory means unchanged ordinary workers and feature off; no new poller or
startup grant is introduced. Migration210 is now confirmed exclusively #662;
208/#661 and209/#663 source files remain outside delivery ownership.

The delivered #663 v1 exports no detail projector; the actual separately delivered
v2 `lifecycleDetail` is the projection used for integration. Its v1 stop worker
also supplies a lease UUID without inserting the actual208 stop operation required
by the managed controller. #663 must supply its repaired reservation/publication
implementation before stop-lane enablement; the controller will not synthesize
that lifecycle decision or silently accept a nonexistent operation.

Owner message/steer completion delegates to the actual separately delivered #663
v2 `LifecycleRuntimeStore.complete` method through a bound assembly adapter.
Its transaction commits the operation/event and authoritative #209 owner activity
together, even when no provider events are polled. No new owner-activity policy
or callback implementation is invented; the v1 artifact alone lacks that hook.
The composition interface requires this actual method as well as the v2 detail
projection before constructing a service bundle.
