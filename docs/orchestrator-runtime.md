# Persistent orchestrator runtime (#662)

## Release and deployment boundary

Issue #717 remains **blocked**: no production provider/harness pair is enabled.
`serve` still requires a trusted service factory for the real runtime/lifecycle/
child bundle. This change adds deployment-intent diagnostics, not a native driver
or production composition. Ordinary sandboxes and their authorization are unchanged.

### Server setting and capability diagnostics

`ARMADA_ORCHESTRATOR_PAIRS` is an explicit, default-empty comma-separated list of
`provider:harness` pairs. For the intended initial Boat rollout:

```sh
ARMADA_ORCHESTRATOR_PAIRS=boat:claude,boat:codex
```

**This does not enable either pair today.** Both remain `enabled: false` with
`boat_native_checkpoint_restore_unavailable`. Requested Modal pairs report
`modal_activation_not_supported`; unrequested pairs report `server_setting_off`.
Unknown entries fail server configuration without echoing their value. With no
setting, the existing `{version:1,enabled:false,reason:"native_conformance_required"}`
response and unavailable mutations are unchanged. With a nonempty setting, HTTP
and MCP capabilities additionally report all four pairs, their `requested` intent,
`enabled: false`, and individual reasons. No request parameter can override this.

Rollback of this partial diagnostic change is to unset the setting and restart:
no identities, history, credentials or native state are deleted. This is **not** a
claim that removing a future admission flag alone revokes running private grants;
a future live activation must define epoch revocation/drain during rollback.

### Concrete Boat native blocker and required owner decision

The locked `@boatdev/sdk@1.13.0` has VM `resume`, `stop`/read-only stop receipts,
`conversations`, and text-bearing `prompt` operations. `Conversation` includes
`running`, `lastHarness` and `lastModel`, but no native session identity or
checkpoint acknowledgement. `StopOperation` proves VM archival, not a native
session checkpoint, event watermark/ACK, or no-text session restoration. There is
no native checkpoint/restore or no-text session handshake operation in `BoatApi`.

`createBoatOrchestratorProvider` provides pinned private SSH boot identification,
epoch broker compare-install/scrub and interrupt delivery. It does not provide
native process observation, checkpoint receipts or restore verification. Interrupt
acceptance and a non-running conversation are not native quiescence/checkpoint
proof. Ordinary Boat turns run via Boat's `api.prompt`, not Armada's Runner.

The existing Armada Runner can checkpoint **its own** journal/processes. It cannot
observe Boat-owned turns: its empty journal would falsely imply quiescence and
contains no Boat session mapping. Its Codex driver supports a private no-text
handshake for Runner-owned sessions, but its Claude driver has no `resumeSession`.
Installing a second Runner beside Boat's native process does not bridge these
contracts and is not an acceptable capability declaration.

The owner must choose either (1) authorize a separate implementation of an
**Armada-owned harness runtime on Boat**, including private runtime transport,
native process/session ownership, credentials lifecycle, durable journal ACKs and
both Claude/Codex restore drivers, or (2) obtain upstream Boat native observation,
checkpoint and no-text restore ports with session/generation/operation correlation.
Then implement the actual production bundle and review each pair's live evidence.
A boolean override, replayed transcript, generic VM resume or synthetic prompt
cannot clear this blocker. No new agent CLI, VM or production call was used here.

SQL/native generation binding is already implemented in the merged authority:
`installEpoch` checks SQL `lifecycle_generation`, persists separate
`orchestrator_native_generation`/`native_generation`, and ACK/admission compare the
native identity independently. The old blanket mismatch warning is stale; this
is not proof of Boat-native continuation. Delegated wait mutations remain outside
the actual four `worker:*` scopes: see the lifecycle document for the precise
unsupported boundary.

### Operator smoke (after real activation, not proof of native conformance)

The coordinator owns `scripts/orchestrator-smoke.ts`. After future real activation,
the operator supplies `ARMADA_TOKEN` in the host environment and runs:

```sh
ARMADA_ORCHESTRATOR_SMOKE=create_real_compute \
  bun scripts/orchestrator-smoke.ts https://approved-origin.example \
  ORG GOLDEN claude MODEL ACCOUNT [REPO]
```

Replace `claude` with `codex` for that pair. `ARMADA_BIN` optionally selects the
installed CLI; the script sets `ARMADA_URL` to the explicit origin. It exercises
create → send → cursor events until settled → stop → resume → stop and prints a
pass/fail receipt. Current disabled capabilities must fail; do not bypass the
guard. After failure, **do not blindly rerun**: retain receipt/idempotency keys,
inspect the recorded operations, and reconcile because compute may still be
running. The script does not auto-delete resources or prove native conformance.
No production smoke was run here. Local tests and this operator smoke cannot
replace the native conformance matrix below.

## Shared owner policy and durable state

HTTP `/api/v1/orchestrators` and MCP `orchestrator_*` use `callOrchestrator`.
Owner reads require current membership and never grant organization admins access
to another owner's private orchestrator. Event cursors bind owner/org/parent.

Logical identity and create-key relation commit before allocation. The canonical
request digest binds actor, organization, action, target and exact payload. Fork
correlation uses the operation ID; unknown allocation is never blindly retried.
Named credentials retain their actual ID/version; provider, repository, harness,
model and effort remain pinned. Machine size uses the merged launcher policy:
explicit override > selected repository > golden > legacy default.

Before the first prompt, the pinned public skill installer installs armada-manager
and review dependencies, checks provenance and refuses conflicts without replacing
unrelated user files. Private scoped authority is configured automatically; no
owner/browser refresh token or manual key is copied into a prompt.

Native text/tool history is mirrored durably with upstream identities and cursor
publication. Stop drains checkpoint-acknowledged history before publishing a
successful stopped receipt, including when no owner ever polled events. Stopped
owner history reads use only the durable mirror and never activate compute.

### Unknown-command recovery

`POST /api/v1/orchestrators/reconcile` (MCP `orchestrator_reconcile`) is read-only:

- Send the original `Idempotency-Key` header and `{orgId, action, id,
  expectedRevision, text?}` for a mutation.
- For create, send `{orgId, action: "create", configuration: <original create>}`.
- `admission: "recorded"` returns the exact receipt matched by actor/org/target,
  action/key and canonical request digest, including pending/uncertain receipts.
- `admission: "unknown", operation: null` means no committed matching receipt was
  visible. It is **not** proof of non-admission: retain the client's unknown fence.
- Changed payload under an existing key is a conflict. Foreign/removed owners
  cannot inspect receipts. No model-account or provider lookup is required.

Same-key mutation retries discover an existing receipt before account preflight.
A stale/busy reservation rejected before effects returns structured
`error.admission: "not_admitted"`. A post-effect publication fence failure returns
`error.admission: "unknown"` plus the already-reserved operation identity.
Unqualified network/503/conflict failures never imply non-admission.

## Two independent generation fences

Migration216 adds `sandboxes.orchestrator_native_generation` and
`orchestrator_delegations.native_generation`. Provider-native identities (Boat
kernel boot UUID / Modal incarnation) are not SQL lifecycle counters.

Authority install records native identity under the exact observed SQL lifecycle
snapshot. ACK checks both snapshot and native binding. Ongoing admission checks
native binding, epoch, current membership, parent state and stop fences; ordinary
activity-counter increments do not prematurely invalidate a 24-hour epoch.
Changing native binding revokes the epoch, including rebinding an old name.
Old delegations without native binding fail closed until a fresh private install.

The private transport compare-installs by native incarnation and epoch, retains
monotonic tombstones, and hash-compare-scrubs failed delivery. No bearer is written
to argv, public events, native config, golden or checkpoint files. Active turns
must quiesce before rotation/scrub; no native-client hot reload is assumed.

## Stop, cleanup and lifecycle composition

The managed lane uses durable stop reservations and a dispatch fence before
external effects. It revokes authority, quiesces, observes correlated native work,
scrubs, checkpoints/stops, mirrors final history and saves only a safe correlated
receipt. Reconciliation reads that exact operation; it never repeats stop,
restores or allocates. SQL generation and native identity travel separately.

A parent with no first conversation can stop without inventing a native session.
Such a checkpoint reports unverified continuity; a non-existent conversation is
never represented as a verified native resume.

Removed-owner cleanup uses narrowly machine/generation/operation-bound trusted
Modal store/outbox authorization. Ordinary owner reads and provider operations
continue requiring membership. Cleanup handles cannot allocate or resume, and
observation-only handles cannot mutate. Model-account revocation never prevents
already-owned compute cleanup.

`createOrchestratorServices` accepts the actual #663 configure/activity/detail/
worker ports. It does not implement child admission, editable lifecycle policy or
wait ownership itself. Existing fair server-worker lanes receive the supplied
lifecycle worker; no second poller is introduced. Actual lifecycle/auth producer
composition must be supplied before activation, not replaced by test fakes.

## Local/CI evidence

Normal `bun test` includes `orchestrator-runtime.test.ts`, which imports the SQL
runtime/backend/managed-stop/Modal-adapter regressions. These were previously
explicit-only `.integration.ts` files. The real PostgreSQL runtime publication
race is also run explicitly in CI against its disposable database. Tests cover
request reconciliation/privacy, stale and late publication, final history,
promptless stop, removed-owner cleanup and distinct SQL/native generations.

```sh
bun packages/agent-runtime/build.ts
bun scripts/validate-runtime-native.ts
bun run verify
# CI's existing disposable PostgreSQL only:
ARMADA_TEST_POSTGRES_URL=<disposable-test-db> \
  bun test ./packages/mcp-server/test/orchestrator-runtime-postgres.integration.ts
```

The dependency-only composition fixture requires the actual #663 producer
modules. The native-credential admission fixture now passes against merged #604
and is included in normal verification; neither is native conformance.
The private Runner-owned Codex no-text handshake tests verify exact thread/model
identity without `thread/start` or `turn/start`. They do not cover Boat-owned
sessions. Claude has no verified equivalent and must remain disabled until its
real driver supplies one.

## Live checks required before any activation

For **each** Boat/Modal × Claude/Codex combination to be enabled, use a newly
owned nonproduction fixture, never the historical stopped Modal App:

1. Install the reviewed pinned public skills before first prompt; record source
   revision/provenance and prove unrelated files survive/conflicts fail clearly.
2. Prove private epoch compare-install/ACK, reordered-delivery rejection and
   hash-compare-scrub; verify no grant in native state, argv or public logs/events.
3. Run a real native turn exceeding 15 minutes and successfully call scoped tools
   after minute 15; reject revoked membership/stale scope and verify bounded epoch
   rollover without manual reauthentication or assumed hot reload.
4. Quiesce/revoke/scrub and checkpoint with exact native incarnation, durable event
   watermark/ACK and correlated operation receipt. Verify final text/tool history
   remains readable after stop without activation, including no prior polling.
5. Restore without text, prove the same saved native session/conversation, reject
   missing checkpoints/stale generations, then continue with the original named
   account/version, model, effort, harness and provider.
6. Exercise no-message stop, removed-owner cleanup, lost response/read-only receipt
   recovery, and current/retired-secret redaction with actual auth/lifecycle adapters.

Deploy existing account/foundation schema, runtime215, then native-binding216 in
migration order (plus independently owned lifecycle schema when composing #663).
Keep feature disabled until that matrix entry's evidence is reviewed. Rollback
means disable admission, revoke epochs and retain identity/history/native state.
