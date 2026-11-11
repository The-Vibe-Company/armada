# Persistent orchestrator runtime (#662)

> **Compatibility-window recovery:** the current CLI no longer implements the
> orchestrator command. For existing-compute inspection/recovery only, define
> `armada_legacy` using the exact **2.21.0** npm invocation in the
> [pinned recovery setup](cli-orchestrators.md#existing-compute-recovery-during-the-compatibility-window)
> and verify its version before running the commands below. Use the existing
> owner's session and approved `ARMADA_URL`; never log credentials. The sandbox
> replacement does not recover existing managed parents. Create/smoke examples
> below are historical, not current deployment instructions or authorization
> to allocate compute. Server/database retirement remains gated.


## Release and deployment boundary

## Boat best-effort and Modal native continuity (#752)

Boat × Claude and Boat × Codex are opt-in **best_effort** pairs: clients should
label them “resume not guaranteed”. Their stored continuity is always
**unverified**, never **native**. Ordinary Boat stop keeps disk and conversation
metadata; resume starts compute and reuses the saved conversation if still
available. Missing or incompatible conversation metadata now starts a fresh
conversation on the next user send: the parent is ready/unverified and the resume
receipt carries `previous_conversation_not_continued`. Existing mirrored history
is retained. No transcript replay, synthetic prompt or invented native checkpoint
is used. See [the Claude session investigation](boat-claude-resume.md).
Modal × Codex retains its verified-native checkpoint/restore contract unchanged.

Enable only the desired pairs (default remains off):

```sh
ARMADA_ORCHESTRATOR_PAIRS=boat:claude,boat:codex,modal:codex
# Optional legacy metadata only; no longer selects an orchestration skill.
```

Use the existing Boat golden **two-repos-prod-test**, its ID from
`armada golden list --org ORG --json`, and an authorized named account for the
selected harness. Keep the ordinary server/database/encryption configuration and
already-deployed foundation/runtime/lifecycle schema. No new migration is needed.
The CLI-only postflight smoke and public orchestrator command were retired in
step 3 of #984. Do not run the historical CLI create/send/stop/resume procedure.
Use [ordinary sandbox scoped Armada access](sandbox-armada-access.md), delivered
in #1002, for new work. Backend/native/HTTP conformance and cleanup remain
separately gated; this removal does not stop existing orchestrators or release
their compute.

Authority revocation, delegation, ownership, idempotency and generation fences
remain mandatory. Best-effort is not a claim of verified harness restoration.

Local live probe: `boat --json info self` returned HTTP401 (CLI session not
signed in). No stop was attempted on this delivery sandbox and no native live
continuation is claimed; the operator smoke is required to observe actual Boat
behavior with an authorized fixture.

## Enable Modal × Codex (operator only, default off)

Configure the server running this PR with:

```sh
ARMADA_ORCHESTRATOR_PAIRS=modal:codex
# Optional legacy metadata only; no longer selects an orchestration skill.
```

Skill selection is caller-owned via `--skill org/slug@version`, not a server
revision. Keep the existing server configuration: `ARMADA_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`ARMADA_AUTH_SECRET`, `ARMADA_PUBLIC_URL` (externally reachable HTTPS), and
`ARMADA_ENCRYPTION_KEY` (the existing 32-byte base64 key, **do not rotate it**).
Use the built server with its pinned Linux-native Runner artifact; no new provider
secret belongs in server arguments or this setting. Existing account202,
model-auth203, foundation208, runtime215, native-binding216 and lifecycle217
schema must already be deployed in order. Apply the new receipt migration
`20261110180000_orchestrator_skill_receipt.sql` before rolling out this code.

In the caller's organization, use an existing **Modal** golden with a saved
snapshot and its immutable workspace/environment/App binding registered by
Armada. The bound Modal org/user credential must still be present in the vault;
use the normal provider setup and golden creation path, not a hand-written App ID
or the historical stopped conformance App. The golden must contain `git`. When selecting a method, it must also contain
the released native `skillpack` CLI on PATH and have public Skillpack catalog
egress. No npm fallback or remote installer is fetched. Leave the reserved
`armada-tools` discovery directory absent; conflicting files fail closed rather
than being overwritten. Other Skillpack package conflicts follow the native
installer policy.
The optional repo must exist in that golden. Select a current named **Codex**
model account owned/authorized for the caller, a supported model and optional
effort. Rotating native Codex accounts retain ordinary exclusive ownership: a
parent-owned native account cannot also be claimed by a child. The composition
consents only to the selected golden/account; child launch must fail before
allocation when that account is busy, not bypass its lifecycle hooks. A shareable
API-key account can launch children under its normal policy. Keep the caller's
GitHub connection valid when the golden requires it.

Restart the server through the normal deployment process, then authenticate as
the owning member and check `armada_legacy orchestrator capabilities --json` against its
origin. Only explicitly selected supported pairs report `enabled: true`; Boat pairs
report best-effort continuity and Modal × Claude remains unavailable. This reports real configured adapter availability, **not** a
claim that operator live conformance has already passed. Owner create/detail/
send/steer/events/stop/resume use the shared `/api/v1` runtime across CLI,
dashboard and iOS. Delegated waits stay denied and are not required for this flow.

### Historical live postflight; retained cleanup constraints

The coordinator—not the implementation session—runs postflight against production
with the owner's account immediately after enabling. No separate nonproduction
origin exists or is required by this approved procedure. Use a **new owned**
Modal × Codex orchestrator, never an existing user's fixture or old Modal App.
The CLI-only `scripts/orchestrator-smoke.ts` runner and its public command
were retired in step 3 of #984. They are no longer an executable postflight.
The native/HTTP service and rollback/compute-release retirement remain gated on
coordinator authorization; this client removal is not that authorization.

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

Modal × Claude remains unavailable (`native_resume_driver_unavailable`).
Boat pairs use the owner-approved best-effort exception above, not native
checkpoint support. Delegated waits report `admit_wait_not_supported`.
Unknown pairs fail configuration without echoing values.

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

Verified native Boat continuity would still require either (1) a separately authorized implementation of an
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

## Create admission, background preparation and failure settlement

Create now returns its durable **pending** receipt after owner/member SQL admission,
without waiting for provider lookup/fork, repository setup, public skills or epoch
installation. Poll detail/events by that receipt's orchestrator ID; a pending
receipt is admission, not a ready machine or completed model turn. Selection
validation in the background can produce a failed preallocation receipt. Transport
loss still requires the identical original key/payload—never a new allocation key.

The production worker claims only new tagged queued jobs. Dispatch/lease tokens,
planned sandbox UUID and a pre-fork SQL fence prevent duplicate allocation and
late dispatch after owner abort. Dispatched/legacy ambiguous jobs are not blindly
forked again after restart; uncertainty requires exact reconciliation/recovery.
Shutdown closes admission and tracks/drains work. No owner browser token or model
credential value is persisted in the job marker.

The launcher hands off the exact committed registration tuple before any init.
Failure publication therefore compares against the initial created sandbox's
actual SQL generation, not the old null preallocation snapshot. Initialization
status writes are fenced by original operation/revision/sandbox/generation;
stale work must not overwrite a recovered or newer machine. Failure receipts can
settle without falsely publishing success or adopting newer state. Database
outages remain explicit uncertainty, never a basis to repeat provider effects.
Managed initialization never uses generic logical-ID stop/delete cleanup: only
exact owner recovery may terminate its captured original resource, so a late
catch cannot stop a replacement incarnation.

Managed parent MCP setup uses a private operation-scoped path. The ordinary public
MCP registry intentionally still hides parents, including from owners/admins.
Default connections are preserved; the internal path checks current private owner,
membership, exact pending operation/revision and SQL generation before/after SQL
transactions. Native turns use the same internal validation; resume prepares MCP
before reinstalling the private epoch, not through assumed hot reload. A golden
rebuild cannot repair a server that passed the parent through the public registry.

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
sessions. Claude has no verified equivalent: Modal × Claude and native-continuity
claims for Boat × Claude remain disabled until a real driver supplies one.
Boat × Claude is available only under the best-effort policy above.

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
Boat pairs are separately opt-in best-effort; Modal × Claude remains disabled. Rollback retains identity/history/native state.

## Skill selection

Managed parents now receive only a minimal Armada tool reference by default.
Select a public Skillpack method with create `--skill org/slug@version`; see
[CLI orchestrators](cli-orchestrators.md#optional-skillpack-method).
