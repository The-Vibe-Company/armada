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
208 and requires integrator slot confirmation. It owns runtime configuration,
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

Deploy account migration 202, reviewed foundation 208, then confirmed runtime
migration 210 (and #663's independently owned migration if needed), regenerate
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
