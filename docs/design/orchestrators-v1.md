# Persistent orchestrators v1 — #647

Status: implementation-ready contract, **not enabled runtime behavior**. Source
baseline: `9d90d694c9c25287fd84e9564615af4486ae0ce4` (v2 main).
`packages/core/src/orchestrator.ts` is the browser-safe, versioned wire contract.
No migrations, production launches or delegation are performed by this PR.
This intentionally extends #455's launcher: the coordinating conversation uses
ordinary launcher services; Armada does not gain an automatic merge queue.

## Source audit and reuse

| Existing owner | Observed mechanism / required delta |
| --- | --- |
| `core/src/launch.ts` | `LaunchRequest` selects golden name/provider, harness, repo, model/effort, connections, TTL; `launchSandbox` resolves visibility, credentials, repo cwd, no-env fork, preparation, then prompt. New service resolves golden ID to this existing lookup without allowing ambiguity; create without prompt, install skills, configure scoped MCP, then admit first message. |
| `core/src/sandbox-provider.ts` | Boat/Modal routing, pinned Modal workspace/environment/App, provider lifetime bounds (30d/24h). Preserve these bindings; no cross-provider restore. |
| `core/src/sandbox.ts`, `sandbox-activity.ts`; `mcp-server/src/data.ts`, `sandbox-lifecycle.ts` | Existing `lifecycle_generation`, activity token/until, reconciliation leases, stop intent, TTL, observation and retry. Reuse machine fences and worker loop; add orchestrator admission/idle decision before stop intent, not another provider poller. Current TTL is absolute, default 4h: it is NOT inactivity. |
| `core/src/provider.ts` | `capabilities[harness].resume`, prompt conversation ID, getPrompt, events/cursor, steer/interrupt, stop; no explicit resume method. Resume must use provider-supported conversation continuation, never invent a provider.resume call. |
| `provider-modal/src/provider.ts`, `store.ts`, `snapshot.ts`; `agent-runtime/src/state.ts`, `journal.ts`, `claude.ts`, `codex.ts` | Logical sandbox restore, physical generation, checkpoint watermark and durable event ACK, native harness state. Uncertain checkpoint preserves source. Do not build duplicate native history storage or treat physical exit as verified checkpoint. |
| `mcp-server/src/caller.ts`; `auth/src/verify.ts`, `service-tokens.ts` | Per-request authentication/current memberships and hashed revocable tokens exist, but caller is user/org authority, not child-scoped delegation. Add a separate principal branch; never mint a normal broad service token for an agent. |
| `mcp-server/src/control.ts`, `tools.ts`, `tool-api.ts`, `turns.ts` | Shared control/MCP operations, sandbox visibility, prompt status/wait. Extend shared service, not independent mobile/dashboard policy. |
| `mcp-server/src/launch-credentials.ts`; `core/src/credentials.ts` | Harness credential selection user-over-org exists; **#612 supplies named credentialId/credentialVersion selection** (pending main integration). Consume its resolveCredentials adapter; do not duplicate account schema. #604 native private-state pipeline is incomplete; do not claim support. MCP connections are not model accounts. |
| `cli/src/skill-install.ts` (#633 / merged PR #639, `9f47264e4c3a9a098906162815a2f1b4949030ba`) | `armada skill install --project DIR --yes --revision SHA` installs armada-manager, ship-pr-dev, review-code-dev, capture-learning-tools for both harnesses from public GitHub, refuses overwrite/symlinks. Reuse this exact installer. |
| `mcp-server/src/mcp-integration.ts`, `mcp-lifecycle.ts`, `mcp-native.ts`; `core/src/connections.ts` | Existing MCP preparation/grant lifecycle remains for external integrations; orchestrator authority is a separate restricted Armada connection, never an external OAuth refresh token copy. |

No archived v1 folder is restored. Existing worker launch stays unchanged.

## Identity, persistence and continuity

Orchestrator is private to its owner (even org admins cannot read chat); current
org membership is required for every request. Golden/account authorization is
also checked at every new start. Owner and org are immutable. The orchestrator
is a coordinating role, never a recycled worker pool. Every child still has one
issue, one dedicated agent/sandbox, one focused PR; it never merges by default.

New tables (future reviewed migrations, not this PR):

- `orchestrators`: UUID PK, org/owner FKs, golden FK, immutable provider/binding,
  harness, model/effort, account FK, repo, name, resolved limits, state, revision,
  sandbox FK nullable, native conversation ID nullable, continuity, reviewed skill
  SHA, timestamps, idle deadline, safe blocked reason. Store effective defaults,
  not omitted request values. No raw credentials in this row. Managed parent sandbox is always launched
  with `visibility: private` and owner/access_owner equal to the orchestrator owner,
  even from an org golden. Persist a server-only managed-parent relation before
  admission. All existing worker list/status/log/send/steer/exec/stop/delete paths,
  dashboard direct Supabase reads and retention jobs must honor that relation: no
  other org member/admin visibility, and even the owner cannot bypass orchestrator
  operation fencing through generic worker mutations. Read-only owner sandbox
  diagnostics may remain; generic mutations refuse managed parents and point to
  orchestrator API. Audit SQL/RLS and MCP/control paths, not only new-table RLS.
- `orchestrator_operations`: UUID, orchestrator, actor, action, idempotency key,
  canonical request digest, expected revision, reserved revision, state,
  provider correlation, safe error. Unique `(actor, org, action, target, key)`; immutable target is orchestrator ID
  (fixed `create` sentinel before identity exists), included in receipt lookup; same key
  with different digest conflicts. Retain receipts for identity lifetime.
- `orchestrator_children`: orchestrator/sandbox unique pair; sandbox belongs to
  exactly one orchestrator; owner/org immutable and equal to parent. Reserved
  start entries count against limits even while allocation is uncertain.
- `orchestrator_waits`: ID, kind, reference, reason, created/deadline/expiry,
  released timestamp and revision. Indexed active expiry.
- `orchestrator_delegations`: token hash (same lowercase SHA-256 convention),
  owner/org/orchestrator, scopes, allowed golden/account IDs, limits,
  physical-generation binding, expiry/revocation, token-family revision.
- `orchestrator_events`: ordered sequence, unique upstream event identity plus
  sandbox/conversation/generation, event JSON, revision, timestamp. Durable
  mirror of normalized events/control receipts, NOT substitute native history.
  Native session/checkpoint storage remains provider/runtime-owned.

RLS owner+current-member SELECT only; no direct client mutation of operation,
delegation, child, wait or event rows. Service code must carry equivalent checks
because it bypasses RLS. Explicit column grants, no token hashes/ciphertext in
user reads, no default grants. Regenerate database types after migrations.
Retain chat/checkpoints until explicit future owner deletion policy; idle stop
must never trigger existing worker retention deletion. Exclude managed parents
from `cleanupSandboxes`; children retain ordinary worker retention. Account/org
removal revokes authority immediately; cleanup via trusted server identity must
still stop owned compute without granting removed users access.

Transitions: creating -> ready or blocked; ready -> stopping -> stopped;
stopped -> resuming -> ready or blocked. Failed/uncertain operations set blocked
with observable reason; reconciliation resolves known receipt rather than
allocating anew. Ready means admitted compute, not necessarily idle. Resume is
idempotent when already ready. Stop when stopped is successful without new I/O.
Conflicting mutations serialize under DB row lock and revision CAS. Stop closes
new admission first, then requests controlled checkpoint/stop, confirms provider
state, publishes stopped; lost responses remain uncertain until reconciled.

`revision` serializes logical operations, not the existing machine lifecycle
counter or physical generation. Check both fences before applying delayed
results; persist operation/provider correlation before side effects. A timed-out
create must never blindly re-fork: reuse provider idempotency/correlation and
reconcile; lack of a conclusive lookup means blocked, not a second charge.

Continuity: not_started until first native conversation receipt; native only
when supported capability and saved native ID/state are verified. Stop/resume
must preserve the same conversation ID and checkpoint. Unverified recovery is
blocked; proven missing native state is lost, requiring explicit owner decision
to start a *new* orchestrator/conversation. Transcript replay is never called
native resume. Do not switch harness/provider/account/model mid-conversation.
On Boat, confirm adapter-supported stopped-conversation continuation. On Modal,
require committed checkpoint/event watermark; physical exit without checkpoint
is not resumable. Provider capability alone is insufficient proof of saved state.

## Delegated authority

Owner creates consent through authenticated create, capped by server policy.
Default scopes: worker launch/read/message/stop, only same-org children recorded
under this orchestrator, using an owner-approved golden/account allowlist (default
selected golden/account). No arbitrary exec, deletion, resume of unrelated
sandboxes, golden mutation, organization/member/key management or token minting.
Do not pass this principal to an unrestricted user Caller. API and MCP enforce
intersection of scope, current owner membership/role, parent state, generation,
resource ownership, allowlist and limits on **each** request. Unknown methods deny.
Owner-only APIs reject delegated principals except bounded own wait registration
and renewal. They cannot read another parent's chat or events.

Use a random opaque bounded epoch grant (at most 24 hours), hashed at rest,
with a revocable family revision and physical-generation binding. Every tool
request rechecks membership, scope, parent state and child/resource ownership.
There is no public renewal/mint route and no copied browser refresh token.
Private transport delivery and initial session ACK precede admission; configureMcp
alone does not prove live reload. Long native turns do not depend on 15-minute
configuration rotation. Runtime must drain and scrub before the epoch deadline,
then establish a new acknowledged session at a proven native continuity boundary.
No unbounded token or assumed hot reload is permitted. These ports remain off
until operator-run native conformance proves this behavior on each backend.
Bind to current physical generation and revoke previous token before restored
compute admits work. Stop/revoke/org removal revokes family, cancels queued
launches, disallows new messages; in-flight provider operations reconcile under
the old receipt without authorizing additional work. Child compute is not silently
deleted/stopped on parent idle stop; known child waits keep parent active. Owner
manual stop warns of active children and exposes their independent stop controls.

No browser session, Supabase refresh token, provider key, service role credential
or owner service token goes to agent/golden. Model credentials still follow the
existing per-sandbox injection path, not delegation. Grant is configured privately
at runtime, never in prompt text, source, events or snapshots; restore scrubs old
grant before rotation. Audit principal/action/target/receipt only, not secret text.

## Inactivity, limits and recovery

Defaults exported in core: idle 2h, configurable 15m–24h inclusive; 3 active
children as an optional owner-configurable concurrency choice. There is no
synthetic daily-start quota, provider allocation cap, reserve or Boat quota
pacing. Actual provider refusal is reported truthfully. Count pending/uncertain
starts when an owner selects a concurrency limit; reserve atomically with an
idempotency receipt before provider I/O and release only on confirmed
non-allocation or final stop. Provider TTL is separate from concurrency.

Actual activity is admitted owner message/steer, queued/running prompt, tool
execution, unfinished review/task, active child, or validated CI/external wait.
Page views, log polling, heartbeat alone, and empty logs are not activity. Query
prompt status and tracked work; log silence never proves idle. Durable waits
expire after 15m, renewable with fresh evidence up to 24h from registration;
completion releases immediately. Same reference cannot reset absolute deadline.
Beyond 24h require explicit owner extension recorded as new consent, not silent
agent renewal. Child waits derive from persisted child status; task/tool leases
need runtime status evidence. CI references bind repository/run to authorized
work; no arbitrary URL fetch/SSRF. External waits require owner-approved source.
Expose reason, expiry and absolute deadline in detail/events.

Before idle stop, under same admission fence: no pending operations, no queued/
running work, no active children or unexpired evidenced waits, then elapsed idle
cutoff since last meaningful activity. Expired/unknown status is **not** proof of
idleness: block/report for reconciliation; bounded leases cannot extend authority
forever. At absolute wait cap mark blocked, notify owner via UI event, stop only
after quiescence is confirmed. Reconciliation retries every minute with existing
2m lease; failure is observable, no fake successful stop.

Provider TTL remains a separate hard limit. Start with each provider's maximum
TTL, not the worker 4h default. Schedule checkpoint well before expiry (10m
margin), inhibit new admissions, drain/checkpoint and restore with fences if
work remains and authorized budget permits. Nonquiescent work at provider hard
expiry is reported interrupted/continuity unverified, never successful idle stop.
Neither Boat nor Modal can promise infinite uninterrupted tool execution. Runtime
implementation must test this rollover before advertising long-lived operation.

## Authenticated API and clients

Proposed routes below are new `/api/v1/orchestrators` endpoints in the existing
control HTTP handler; do not assume they exist today. All use the same server
service as MCP tools `orchestrator_*` and CLI. JSON uses exported v1 types, UTC
ISO dates, opaque IDs. Reject unsupported versions, unknown fields, invalid
models/efforts/accounts and out-of-range limits at server boundary.

| Method/path | Input / response |
| --- | --- |
| POST `/orchestrators` | `OrchestratorCreate` -> 202 `OrchestratorOperation`; persist logical identity before allocation |
| GET `/orchestrators?orgId=&cursor=&limit=` | owner only -> `OrchestratorList` (default 20, max 100) |
| GET `/orchestrators/:id` | `OrchestratorDetail`, includes pending operations, waits, children and delegation metadata only |
| POST `/:id/message`, `/:id/steer` | `OrchestratorMessage` -> 202 operation; message continues native ID, steer requires running turn |
| POST `/:id/stop`, `/:id/resume` | `OrchestratorFence` -> 202 operation; resume restores without synthetic user text or silently opening a new conversation |
| GET `/:id/events?cursor=&limit=` | `OrchestratorEventPage`, default 100 max 500; poll-safe stable cursor, scoped to owner/orchestrator, no provider cursor leakage |
| POST `/:id/waits` | `OrchestratorWait` -> wait lease (owner or own delegated principal) |
| POST `/:id/waits/:waitId/renew` | fence + requested expiresAt -> lease, evidence validated, deadline unchanged |
| POST `/:id/waits/:waitId/release` | fence -> 204 |
| POST `/:id/delegation/revoke` | owner fence -> 204; resume needs fresh owner consent to regrant |

All mutations require `Idempotency-Key` (1–128 printable ASCII characters) and
revision except create; scope receipts to authenticated actor+org+action+target.
Repeats return original receipt even after revision moves; digest mismatch 409.
Operation completion appears in detail/events (no separate polling DTO needed).
400 invalid_request, 401 invalid/expired auth, 404 invisible/missing, 409 stale
revision/busy/no native continuity, 429 limits, 503 unavailable/uncertain; safe
`{error:{code,message}}` envelope follows existing control conventions. Client
retries use original key. Cursor is opaque server sequence scoped to identity,
ordered, no gaps from partial upstream ingestion (checkpoint ACK before cursor
commit). Unknown event kinds must be preserved by newer clients; unsupported
versions fail explicitly. Retained events allow reconnect; never persist only a
provider's ephemeral pagination cursor.

Dashboard: compact owner list (name, harness/model, provider, status, last activity,
idle deadline); detail is chat with message/steer, stop/resume and collapsed
children/waits/errors. No wall of design prose. Future mobile and CLI consume the
same APIs; mobile native app, push notifications and broad orchestrator autonomy
are excluded. Existing dashboard Supabase direct worker reads do not authorize
orchestrator mutations; use authenticated control API for this surface.

## Ordered work orders for root (fresh dedicated owners)

These are publishable issue bodies, not work assigned to this worker. Each owner
ships one focused PR, no production actions, no merges; parent dependency #647.

1. **Model account reference adapter**: extend credential schema/resolver with
   owner/org-authorized named model accounts, safe ID/name catalog and harness
   compatibility. Preserve user-over-org default for existing workers. Touch core
   credentials, launch resolver/control and migrations/types. Test denied private
   account/cross-org selection, revoked account, and unchanged legacy launch.
2. **Durable identity and scoped authorization** (depends 1 + contract): add
   reviewed schema/RLS/grants, principal/token family, owner policy, private
   runtime MCP injection and revocation. No compute endpoints enabled yet.
   Test with real migrations/PGlite: admin cannot read private chat or its parent
   through generic worker APIs/RLS; owner generic worker mutations cannot bypass
   parent fences; removed
   member fails next request, expired/rotated generation fails, cross-org and
   unrelated child/credential/admin/exec methods denied, hash unreadable via JWT.
3. **Vertical create/message/stop/resume** (depends 2): reuse launch, runtime
   native state and provider routing; implement receipts/fences/event mirror and
   pinned skill installation before first turn. Introduce provider-specific
   no-text activation port if needed: existing Provider has no resume method.
   Test both fake providers: concurrent create charges once, timeout reconciles,
   stale generation cannot publish, separate-target key reuse is independent while
   same-target changed payload conflicts, checkpoint loss blocks, native ID survives,
   skill conflict fails before prompt, removal during preparation revokes grant;
   bounded epoch remains usable throughout a long native turn, quiescent reconnect uses
   new token while preserving native ID (no assumed live config reload).
   Require opt-in nonproduction Boat/Modal harness continuity conformance before
   marking each backend enabled; do not infer it from mock success.
4. **Child admission, idle and rollover** (depends 3): add child ownership,
   atomic start reservations, waits/evidence adapters, token rotation, TTL rollover
   and cleanup exclusions in existing server loop. Test injected clock: silent
   active turn/review/CI/child survives 2h; polling does not extend idle; lease
   deadline cannot reset; stop/message race has one winner; uncertain stop retains
   receipt; restart/replica race is fenced; account/member removal cannot orphan
   unbounded compute; provider hard expiry reports interrupted, never fake resume.
5. **Compact dashboard and API-only CLI** (depends 3, waits UI after 4): implement
   list/chat/actions using core DTOs and control API, CLI create/list/detail/send/
   steer/stop/resume/events. Preserve CLI no provider/database credential graph.
   Test real policy boundary plus browser reconnect/cursor and stale-revision UI;
   no duplicated policy-only mock tests. No mobile application in this issue.

Migration/deploy order: #647 types (additive, no behavior) -> account migration +
resolver -> private orchestrator tables/policies -> authorization service ->
runtime/skills/native continuity -> idle/limits -> clients. Feature gate off until
server schema, reviewed pinned skills, scoped grant injection/rotation, both
backend conformance and named account resolution are present. Enable backends
independently, refuse unsupported backend rather than fall back. Old clients and
worker rows remain unchanged; no backfill treating workers as orchestrators.
Rollback disables new admissions/revokes grants, reconciles existing receipts and
retains conversation/checkpoints; never drop tables or delete machines blindly.
