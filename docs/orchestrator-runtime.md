# Persistent orchestrator runtime (#662)

## Release and deployment boundary

This PR delivers the backend/runtime integration candidate. **Production capabilities
remain disabled** (`orchestrator_capabilities` / authenticated HTTP capabilities
return `enabled: false`). `serve` accepts a trusted service factory, but does not
construct or enable an unverified provider/harness by default. Ordinary workers
and their existing authorization remain unchanged.

The acceptance decision for this PR explicitly treats live native conformance as
an activation/deployment prerequisite, not a merge gate. SQL/fake-provider/Runner
regressions prove the contracts below, not that a live provider/harness is enabled.
No production operations, manual deployments or migration applications are needed
for development verification.

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

Migration214 adds `sandboxes.orchestrator_native_generation` and
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

The dependency-only composition/native-credential fixtures require the actual
#663/#604 producer modules; they are not passed off as native conformance here.
The private Codex no-text handshake tests verify exact thread/model identity
without `thread/start` or `turn/start`. Claude has no verified equivalent and
must remain disabled until its real driver supplies one.

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

Deploy existing account/foundation schema, runtime210, then native-binding214 in
migration order (plus independently owned lifecycle schema when composing #663).
Keep feature disabled until that matrix entry's evidence is reviewed. Rollback
means disable admission, revoke epochs and retain identity/history/native state.
