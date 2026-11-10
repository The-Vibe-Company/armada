# Persistent orchestrator runtime (#662)

## Release and deployment boundary

## Enable Modal × Codex (operator only, default off)

Configure the server running this PR with:

```sh
ARMADA_ORCHESTRATOR_PAIRS=modal:codex
ARMADA_ORCHESTRATOR_SKILL_REVISION=0976883b70ee3ddedef5f965064bd75a248c5b6e
```

The skill revision is an immutable, public, reviewed commit containing the four
installer packages; the shown merged commit is suitable. Keep the existing server
configuration: `ARMADA_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`ARMADA_AUTH_SECRET`, `ARMADA_PUBLIC_URL` (externally reachable HTTPS), and
`ARMADA_ENCRYPTION_KEY` (the existing 32-byte base64 key, **do not rotate it**).
Use the built server with its pinned Linux-native Runner artifact; no new provider
secret belongs in server arguments or this setting. Existing account202,
model-auth203, foundation208, runtime215, native-binding216 and lifecycle217
schema must already be deployed in order. This PR adds no migration.

In the caller's organization, use an existing **Modal** golden with a saved
snapshot and its immutable workspace/environment/App binding registered by
Armada. The bound Modal org/user credential must still be present in the vault;
use the normal provider setup and golden creation path, not a hand-written App ID
or the historical stopped conformance App. The golden must contain `git` and Node/npm. Existing `armada` CLI installations
are used for skill bootstrap; otherwise an explicitly pinned public CLI installer
is fetched with registry scripts disabled. Public Git/npm egress is required.
Do not preinstall the four managed skill packages into the selected project:
the first-create installer refuses conflicts rather than overwriting user files.
The optional repo must exist in that golden. Select a current named **Codex**
model account owned/authorized for the caller, a supported model and optional
effort. Rotating native Codex accounts retain ordinary exclusive ownership: a
parent-owned native account cannot also be claimed by a child. The composition
consents only to the selected golden/account; child launch must fail before
allocation when that account is busy, not bypass its lifecycle hooks. A shareable
API-key account can launch children under its normal policy. Keep the caller's
GitHub connection valid when the golden requires it.

Restart the server through the normal deployment process, then authenticate as
the owning member and check `armada orchestrator capabilities --json` against its
origin. Only Modal × Codex may report `enabled: true`; the other three pairs must
remain unavailable. This reports real configured adapter availability, **not** a
claim that operator live conformance has already passed. Owner create/detail/
send/steer/events/stop/resume use the shared `/api/v1` runtime across CLI,
dashboard and iOS. Delegated waits stay denied and are not required for this flow.

### Approved live postflight and rollback

The coordinator—not the implementation session—runs postflight against production
with the owner's account immediately after enabling. No separate nonproduction
origin exists or is required by this approved procedure. Use a **new owned**
Modal × Codex orchestrator, never an existing user's fixture or old Modal App.
With `ARMADA_TOKEN` already exported on the operator host:

```sh
ARMADA_ORCHESTRATOR_SMOKE=create_real_compute \
  bun scripts/orchestrator-smoke.ts https://approved-production-origin.example \
  ORG MODAL_GOLDEN modal codex MODEL CODEX_ACCOUNT [REPO]
```

`ARMADA_BIN` optionally selects the installed CLI. The script sets `ARMADA_URL`
from the explicit origin and checks the selected pair before allocation. It runs
create → send a trivial prompt → cursor events until native completion → stop →
no-text resume → stop, requiring stable sandbox/conversation and native continuity,
and prints a JSON pass/fail receipt. Keep that receipt and the exact original
idempotency keys after failure; **do not blindly rerun** an uncertain mutation.
Compute may remain running. The script does not auto-delete. The coordinator owns
cleanup/deletion of this new disposable provider resource after final stop;
delete only the new fixture resource, not the shared App or golden. Logical
identity and history are not deleted by rollback.

The full native matrix below remains the operator's evidence checklist, including
private grant ACK/scrub, generation fencing, long turns and log redaction. A short
smoke alone is not proof of every native invariant. No production operation or
live-conformance result is claimed by this PR's implementation session.

For orderly rollback, stop the newly enabled orchestrators while the runtime is
still available (so authority revocation/scrub and correlated checkpoint execute),
then unset `ARMADA_ORCHESTRATOR_PAIRS` and restart. This disables admission and
scoped tool serving while retaining identities, receipts and history. Turning off
the setting is not proof that an abruptly disconnected guest memory was scrubbed;
if a stop is uncertain, retain its receipt, do not snapshot or delete state as a
substitute for reconciliation, and restore the same configuration to reconcile.

### Unsupported pairs

Boat × Claude and Boat × Codex remain unavailable because native checkpoint/restore
ports are missing. Modal × Claude remains unavailable because the native no-text
resume driver is missing (`native_resume_driver_unavailable`); Boat reasons are
`boat_native_checkpoint_restore_unavailable`. Delegated waits report
`admit_wait_not_supported`. Unknown pairs fail configuration without echoing values.
No setting preserves the legacy disabled response and ordinary-worker behavior.

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
composition is supplied by the production Modal × Codex path in `serve`, not test fakes.

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

## Operator live-conformance evidence checklist

For the approved Modal × Codex rollout, the coordinator uses a newly owned
production fixture after enabling, never the historical stopped Modal App. Any
future pair needs its own native evidence:

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

Existing account/foundation, runtime215, native-binding216 and lifecycle217
schema must already be deployed in migration order; this PR adds no migration.
Modal × Codex is opt-in under the approved operator postflight procedure above;
other pairs remain disabled. Rollback retains identity/history/native state.
