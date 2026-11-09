# Persistent orchestrator runtime (#662)

Status: **disabled, integration candidate**. Ordinary workers are unchanged.
The service is not constructed in `serve`; absent services return `unavailable`.
`orchestrator_capabilities` and the authenticated HTTP capabilities route report
`enabled: false`. Neither an injected fake provider nor passing synthetic SQL
checks enables a real provider/harness.

## Actual foundation consumed

The runtime now integrates merged main, including #661 ready-admission fix
`79472bf` / merge `d748be68`, and #653 sizing merge `ec3b89db`. Earlier
`026babbf` running-only integration notes are superseded. Named-account #603/#612 is now merged (`1eaaf07d`) and consumed on actual
main `e5fc554f`. The newer #604 branch `3fce7076af7ddd5451fa0fcde07ca724c4184f12`
is combined only under `.git/662-auth-current`; no unmerged producer files enter
delivery ownership. Earlier `77eed87c` combination evidence remains historical.

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
  refuses until the slot has been scrubbed. Boat now has an explicit pinned-SSH memory-only broker adapter; native continuity is not enabled.
- Child `Authority.admit` and lifecycle/waits remain #661/#663-owned; this change
  does not dispatch delegated principals as owners.

Initial epoch installation and ACK now accept actual ready/running states in
merged #661. No synthetic prompt or fake running state is needed.

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

The production resolver uses actual SQL membership/golden identity, the v2
provider registry and persisted source management authority, explicit #603
credential ID/version, stored model/effort/cwd for later turns, and the real
merged launcher sizing policy. Parent credential pinning proxies the ORIGINAL
#604 lifecycle object, retaining prototype hooks/admission/hydration/release and
its same-registry redaction/publication rather than copying only resolve.
#604 `refreshNativeSecrets` is synchronous; `publishNativeAuth` is asynchronous.
A native adapter/prerequisite verifier is mandatory per provider/harness; absence
fails closed before allocation. Concrete native adapters/proof remain in progress.

## Boat private epoch transport

The Boat-specific provider wrapper obtains kernel boot identity over pinned SSH
stdin, not labels or the SQL lifecycle counter. Install/scrub controls use the
same private channel. A memory-only broker injects the scoped epoch header into
upstream MCP requests; native Claude/Codex configuration contains only a loopback
URL. Broker code and monotonic epoch tombstones live on verified tmpfs; neither
raw epoch nor derived control key is written into native config, HOME, argv or
snapshot files. Control keys are domain/sandbox/boot-bound HMACs of the server
root key, not owner/provider credentials; the root key never enters the VM.

A durable-per-boot first-seen epoch tombstone prevents delayed older installs and
same-epoch resurrection after scrub/restart. Exact token-hash scrub ignores late
old cleanup. The broker registers credentials before operations, uses only
constant diagnostics, and redacts known epochs in forwarded request/streamed
response bodies. In-flight requests block mutation. ACK means broker/config
delivery only, not live-client/native continuity proof. The 24-hour issuer and
quiescent checkpoint/rollover deadlines remain enforced by the authority and
lifecycle lanes; no periodic manual reauthentication is added.

Generic MCP normalization/allowlists are unchanged. A separate secret-free bridge
ownership marker preserves user/external definitions. Startup composition receives
the existing lifecycle-aware credential resolver using the server's actual #604
ownership object, so native auth/redaction/publication do not split registries.

Outstanding generation policy is explicit: the current authority transport binding
comes from SQL lifecycle_generation, while Boat's kernel boot UUID and Modal's
runner generation are native incarnation identities. They are never compared as
if equivalent or inferred from labels. The current transport fails closed on this
mismatch. A reviewed two-fence binding/rebind contract is still required before
native activation; implementing private delivery does not by itself resolve it.

## No-text native handshake (not restore enablement)

The private `Provider.verifyOrchestratorSession` port verifies an **already active**
native incarnation. Modal holds its native-generation lease while the Runner
checks the journal's exact conversation/harness/native-session binding. The
Codex driver uses its existing JSONL `thread/resume` handshake, verifies the
returned thread and model, and closes without `thread/start` or `turn/start`.
No prompt/event is manufactured; missing sessions, changed native identities and
unsupported drivers fail closed. Prompts and epoch mutation serialize against
this handshake, and checkpoint waits for it to quiesce.

Claude does not advertise this port: no equivalent no-text identity handshake has
been verified against the installed SDK. This is neither provider activation nor
a checkpoint/restore proof, and does not enable either harness/provider matrix.
The production adapter must still restore a verified checkpoint with current
native-auth lifecycle hooks and compare the restored native identity before
installing new authority. No ordinary-worker capability is changed.


The no-text caller preserves actual #604 `refreshNativeSecrets?: () => void`
and `publishNativeAuth?: () => Promise<void>` from the same execution object.
The entire handshake/redactor/publication sequence is tracked: its safe ACK waits
for private publication even after native failure, and checkpoint waits for that
tracked work. An unacknowledged publication is a fixed failure, not success.

Current ordinary Modal stores/ingestion require current membership. Removed-owner
checkpoint cleanup therefore additionally needs a reviewed receipt-bound cleanup
store/outbox authorization path; avoiding model-account resolution alone is not
sufficient. No ordinary membership check has been bypassed. The native capability
matrix remains disabled until this composition and real conformance are complete.
