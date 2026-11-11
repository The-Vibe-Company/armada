# Orchestrator create failures and uncertain receipts

> **Compatibility-window recovery:** the current CLI no longer implements the
> orchestrator command. For existing-compute inspection/recovery only, define
> `armada_legacy` using the exact **2.21.0** npm invocation in the
> [pinned recovery setup](cli-orchestrators.md#existing-compute-recovery-during-the-compatibility-window)
> and verify its version before running the commands below. Use the existing
> owner's session and approved `ARMADA_URL`; never log credentials. The sandbox
> replacement does not recover existing managed parents. Create/smoke examples
> below are historical, not current deployment instructions or authorization
> to allocate compute. Server/database retirement remains gated.


An admitted `create` returning `runtime_uncertain` is not proof of allocation,
non-allocation, or an agent/model failure. The receipt is durable; its original
key must not be replaced to work around uncertainty. Ordinary `armada list`
intentionally excludes managed orchestrator parents, including from their owners.
Use the owner orchestrator endpoints instead.

## Read-only incident capture

With the existing owner session or `ARMADA_TOKEN` already in the host environment:

```sh
armada_legacy orchestrator detail ID --org ORG --json
armada_legacy orchestrator events ID --org ORG --json
armada_legacy orchestrator capabilities --json
armada golden list --org ORG --json
armada creds list --org ORG
```

Select the original origin with `ARMADA_URL`. Save the full original invocation,
create key, operation ID and JSON receipt privately. Share only safe account
metadata from `creds list`, never values, token-bearing environment, auth files,
provider output, or native transcripts.

Detail's `sandboxId` is decisive context, but not sufficient allocation proof:

- Null: failure could precede fork, occur during an ambiguous fork, or occur
  before successful SQL registration. No row in ordinary list proves nothing.
- Non-null: a managed sandbox was linked. Inspect its operation correlation and
  trusted provider receipt; do not infer that a failed create freed its compute.
- `runtime_uncertain` alone does not identify the failing stage. Do not infer
  credential, CLI, snapshot or provider errors from the generic code.

## Synchronous create failure boundaries

The stored `runtime_uncertain` receipt is produced by the effect executor **after**
create reservation commits. Initial backend/golden/account selection, native
adapter prerequisites and initial reservation are outside that catch: their
failures normally reject the request rather than publish this receipt.

The executor can fail at any of these awaited boundaries:

| Boundary | Failure families |
| --- | --- |
| Revalidation | Fresh membership, golden, exact account/version or credential/GitHub reads |
| Parent preflight | Account/request invariants, transaction/schema availability |
| Launcher preflight | Harness/model/TTL, exact-ID golden/snapshot/visibility, repository and size policy, default MCP validation, pinned credentials, golden fence and credential admission |
| Modal fork | Source image/authority/lease, App binding, snapshot readiness, TTL/size, provider reservation, physical create, private environment/Runner bootstrap, readiness |
| Registered launch | Sandbox insert/parent link, MCP binding, readiness/hydration, GitHub setup, repo pull/init, native CWD, MCP preparation and activity publication |
| Preparing | Current owner/revision/generation and parent binding |
| Skills | Missing CLI, installer conflict/nonzero/timeout/detached/truncated output, public Git/provenance |
| Epoch | Revalidation, trusted generation/transport, private install/ACK and SQL/native binding |
| Completion | Transaction failure or stale publication fence |

For a private owned Modal golden with an `openai` API-key account, no repository
selector and no size override: native rotating-account admission is a no-op;
there is no selected-repository CWD check or repository-size default, but a golden
size policy can still apply. Golden repo pull/init and default MCP preparation
still run. Create sends **no model prompt**, so model inference cannot explain its
failure. Configuration and credentials are still revalidated after reservation.

Publication itself matters: before `preparing`, the reservation has no sandbox
generation. If launch links a sandbox then fails before refreshing that identity,
catch publication may reject the generation mismatch and return HTTP conflict/
unknown, rather than a stored uncertain receipt. A stored uncertain receipt can
therefore reflect a pre-link failure/ambiguous fork, a later skills/epoch failure
after identity refresh, or a rolled-back completion. A catch-publication failure
is separately diagnosed; it must never erase the original failure stage.

## Recovery semantics

On the existing owner API, replaying **the same create key and identical complete
payload** returns the original receipt. It does not launch again, repair bootstrap,
or retry the effect. A changed payload under that key is a conflict. The read-only
reconcile endpoint likewise discovers the receipt, not a successful allocation.

`stop` by itself is not an escape hatch for a pending/uncertain create. For the
specific Modal first-create case with **no conversation** and a pending/uncertain
create (with or without an already registered sandbox), the owner can explicitly recover through Armada:

```sh
armada_legacy orchestrator recover ID --org ORG --expected-revision ORIGINAL_REVISION \
  --idempotency-key RECOVERY_KEY --json
```

This reserves a fenced stop-kind recovery receipt, discovers the original Modal
reservation by its **create operation UUID**, and validates owner/org, immutable
App/environment/source, original labels, logical/physical identity and generation.
It does not fork, run a model, resolve model-account values, or use caller-supplied
cloud IDs. It terminates the exact owned resource through Armada's Modal provider
and settles the old create as failed/parent stopped only after positive terminal
proof is durable. A missing lookup/404, wrong tags, new generation or an old generic
`deleted` row is not sufficient proof. Logical identity and history are retained.

Keep the exact recovery key and ORIGINAL revision after an uncertain response;
never substitute the new revision or a fresh recovery key. Successful receipt
replay performs no cloud effect. Repeating an **unconfirmed** recovery manually
may retry idempotent termination of the same freshly revalidated physical
identity; it never allocates/starts/restores a machine or targets a replacement.
The CLI does not automatically retry. The separate provider observation port
never terminates anything. If proof remains unconfirmed, do not create a
replacement or edit operation rows: retain the correlated provider receipt and
follow the operator recovery instructions in the PR. Ordinary `stop` can settle
normally after confirmed recovery clears the original uncertain-create fence.
This recovery is not a native resume; an orchestrator that never began a native
conversation has no verified conversation to resume.

An undispatched new queued job may be cancelled only using its durable SQL
pre-fork fence, which blocks the original callback before any allocation. This is
not inferred from an empty provider list. A legacy pending create or dispatched
job still requires positive native proof. Registered abort also fences the exact
public binding/generation and revokes authority before cleanup; model-account
ownership/credential state is not reset. Keep the same key/revision on manual
recovery after uncertainty.

A **fresh create name/key is another allocation**, not an idempotent retry. It is
safe from duplicating this original resource only after exact recovery succeeds;
that safety condition does not authorize a new orchestrator after retirement.
An empty ordinary list or a missing default Modal CLI profile proves nothing about
the server's pinned workspace/environment/App. Never perform a hand-written cloud
delete or drop logical history as an uncertainty workaround.

## Booting machine failures before public registration

A saved physical ID in provider phase `booting`, while public `sandboxId` remains
null, means the failure is inside `ModalProvider.fork` boot confirmation, before
ordinary sandbox registration. The relevant calls are runtime preparation,
process-baseline capture, fresh-filesystem sanitization, private startup/harness
environment, health and active-publication. It is not the later public skill CLI
or epoch delivery. Exhausting the normal health loop takes at least roughly 30s;
a 3.5s failure cannot be that exhausted-loop timeout, though individual startup or
publication failures can be fast. Safe provider boot codes distinguish these
substeps; do not infer a unique exception from `phase=booting` alone.

Saved goldens contain the Runner artifact from their build date. A fresh logical
fork now installs this server's verified public bundle before baseline/bootstrap,
with pinned Bun and strict root-owned/non-writable/symlink checks. The payload goes
over stdin, not argv, and contains no bootstrap secret. Native checkpoint restore
generations do not silently rewrite code/native state/journal. Existing goldens
without an `armada` CLI use the same installer via explicitly pinned public npm
CLI 2.14.0 with registry scripts disabled; skill revision/provenance/conflict checks
remain mandatory. These compatibility repairs do not assert the exact old
swallowed exception has been recovered.

## Secret-safe server diagnostics

The server emits structured `orchestrator_operation_failure` events for failed,
uncertain and rejected operation paths, including replayed failed/uncertain
receipts and failure-publication errors. Correlate by operation/orchestrator UUID;
these events are diagnostics, not authoritative allocation receipts.

Records identify a literal stage and allowlisted reason rather than logging raw
exceptions. They contain no message/stack, prompt, request payload, idempotency
key, credential, native output or provider exception details. Logging is best
effort: a failed logger cannot change admission, effects, cleanup or publication.
Publication failures retain the original `failureStage`/`failureReason` separately.

Create stages distinguish revalidation; launcher schema/configuration/credential
preflight; fork; registration; initialization/hydration; preparing; skills;
epoch revalidation/transport/install; and final completion. A missing skill CLI,
nonzero installer exit, timeout, detached execution, truncated output and missing
provenance have distinct safe reasons. They do not bypass the pinned installer,
conflict refusal, credential lifecycle, epoch fencing or native guarantees.

The Modal golden needs public Git/npm access and no conflicting managed skill
package directories; an existing reviewed CLI is used when present, otherwise the
pinned public installer fallback is used. These are prerequisites, not a diagnosis of
any particular incident. See [runtime enablement](orchestrator-runtime.md).

## A 404 before recovery admission

Check the effective origin before changing operation keys. The CLI defaults to
`https://armada.thevibecompany.co`, whose dashboard control proxy forwards a closed
owner-route allowlist to the configured MCP/control server. Healthy list/detail
GETs do not establish that a new POST route is admitted by that proxy.

The proxy must include `recover` as well as owner lifecycle settings/waits and
wait renewal/release. The production serve HTTP regression checks the real CLI
against both direct server and public proxy, using the same production factory,
authentication and recovery implementation. A typed runtime not-found has a
structured `error.code`; an unstructured proxy/edge 404 becomes the CLI's generic
transport error. That error now includes the validated target origin, never raw
upstream text, tokens, keys or request payloads.

An export in one short-lived tool shell is not inherited by a later shell. Prefix
the origin on **each** invocation when running separate tool commands:

```sh
ARMADA_URL=https://CONTROL_ORIGIN armada_legacy orchestrator detail ID --org ORG --json
ARMADA_URL=https://CONTROL_ORIGIN armada_legacy orchestrator recover ID --org ORG \
  --expected-revision ORIGINAL_REVISION --idempotency-key RECOVERY_KEY --json
```

Use the existing owner login/token without printing it. Keep the same recovery
key/revision after errors. No fresh create is authorized by this recovery runbook.
Deploy the dashboard proxy update as well as any backend update if using the
public origin; deploying only the Railway server cannot update a separate
Next.js proxy. A direct server unauthenticated POST with empty JSON should reach
its authentication boundary, not admit an effect. If that direct URL still emits
an unstructured 404, capture safe response status/headers/body and verify the
actual deployed service/image/domain routing; do not infer a missing handler from
the status alone or bypass the private owner boundary.

## Initialization failure with a pending receipt after registration

A preallocation reservation has no sandbox generation. A launcher that registers
then throws before refreshing that snapshot could log failure but reject its own
publication (null versus the newly assigned generation), leaving create pending.
The registration handoff now pins the committed initial tuple before preparation;
never recover this by blindly rereading/adopting a later generation in catch.

The ordinary public MCP registry refuses managed parents. Passing its preparation
hook to a parent guaranteed `No such sandbox` even for zero default connections.
This is a server composition defect, not a golden requirement. Internal scoped MCP
preparation fixes it without exposing managed parents to generic APIs. Other
readiness/GitHub/repository/MCP failures have distinct initialization phases and
known causal codes. Raw guest output/status_reason must not be pasted into logs.

Create responds with admission promptly and background work publishes terminal
results; detail/events may show creating/pending while initialization is genuinely
running. Do not mistake that pending receipt for successful preparation. Explicit
owner recovery can abort a never-conversed registered pending first create, fence
late original callbacks, and settle it only after exact termination proof. Do not
use a fresh create key to get around a pending receipt.

## Boat best-effort lifecycle (#763)

Boat parents use ordinary archival, not Modal native checkpoints. Their continuity
must remain `unverified` after resume. The owner lifecycle regression must boot
`startServer` without substituting the orchestrator factory and drive the CLI;
backend-only fakes cannot validate the provider hooks installed by production.

An owner can retire a Boat parent blocked by an uncertain stop, including after
resume. Read detail first and use that revision with a fresh recovery key:

```sh
armada_legacy orchestrator detail ID --org ORG --json
armada_legacy orchestrator recover ID --org ORG --expected-revision REVISION \
  --idempotency-key RETIREMENT_KEY --json
```

Use the same key and original revision to retry an uncertain retirement. Recovery
confirms ordinary archival and publishes `stopped`, but permanently fences resume;
it does not claim conversation continuity or reactivate compute. This also covers
the #763 smoke parents `d31da303-bb66-4959-9a93-59366d9fdc4c` and
`96f80008-d49f-423c-b468-f7d6c48db77d` (their reported blocked revision was 3;
read current detail rather than assuming it is unchanged).

A successful send receipt proves Boat accepted the prompt, not that a harness
started it. If events stay empty, retain sanitized prompt ID, conversation ID,
Boat prompt status and provider event response/cursor for diagnosis. Never include
credentials or guest output containing secrets. The production-composition test
proves request dispatch, event publication and reconnect against documented Boat
responses; it cannot explain an upstream accepted-but-never-delivered turn.

### Boat invalid-request polling and retirement (#779)

Managed owner polling and stop-history reads now use the ordinary sandbox page
size (200), rather than the managed-only 500. Both go through the same SDK events
method, sandbox provider ID, ascending sort and cursor. Managed reads additionally
filter by their persisted conversation. The stop POST uses the same endpoint and
arguments; managed stop additionally confirms the archival receipt and mirrors
history before publishing `stopped`. A history refusal can therefore leave stop
uncertain even after Boat archived the machine.

For remaining refusals, `provider_invalid_request` diagnostics append only known
HTTP statuses, closed Boat codes (`invalid_request`, `validation_error`,
`invalid_params`, `bad_request`) and allow-listed parameter names from
`details.parameter` or `details.field`. Unknown labels, messages and values are
omitted, not sanitized into logs.

**Historical post-deployment validation, not a current smoke instruction:** the
original procedure exercised both Boat harnesses: send, observe a
finished turn, stop, resume with the same conversation, and stop again. Retire
the four blocked parents (`d31da303…`, `96f80008…`, `d1230efd…`, `e57e5266…`)
using the detail/recover commands above with each parent's current revision.
Keep the original revision/key for retries and verify both Armada `stopped` and
Boat archival. This is an operator follow-up, not performed by this patch or its
fake-fetch tests. Do not enable Boat pairs based only on transport tests.

### Boat pull ownership and closed observations

Boat `/prompt` is posted synchronously by owner send. The accepted receipt now
persists `promptId`, `conversationId` and normalized status in the message
operation's `runtime_result` (`kind=prompt_receipt`). It is not a harness-execution
acknowledgement. Legacy message receipts have no prompt ID and cannot be repaired
retroactively from a conversation alone.

Previously managed Boat parents had no background event consumer: owner
`orchestrator events` was the only puller. The server now registers a fair Boat
pull lane alongside create/lifecycle/child workers. It consumes the same provider
cursor and atomic journal/activity transaction as owner reconnects. Polling never
renews owner activity by itself; only new meaningful agent events do. The real
serve regression verifies cursor/activity publication **before** any owner events
request. This repairs missing unattended activity, not proof that the historical
150-second upstream-empty response had the same cause.

Closed JSON observations (`event=orchestrator_runtime_observation`) contain only
Armada UUIDs plus these labels, never prompt text, tokens or raw provider errors:

- `kind=prompt_dispatch`: `accepted` (HTTP receipt returned) or `not_confirmed`
  (dispatch/preparation failed or acknowledgement lost; not proof of no effect).
- `kind=prompt_status`: `queued`, `running`, `finished`, `failed`, `interrupted`,
  `unknown`, `unavailable`. Boat `sending` is normalized to `queued`.
- `kind=events_poll`: `empty`, `published`, `fenced` (another cursor/incarnation
  won), `failed`. Failure records retain the existing closed reason classifier.

For existing-compute incident inspection, compare these labels; an accepted/queued turn
with empty polls is distinct from failed polls or missing dispatch.

Terminal retirement first attempts normal native credential preservation. If
SSH/native capture fails, it durably withholds the unsynchronized native tail
before a private cloud-only archival fallback. Already-published redacted SQL
history remains readable. The permanent stop fence prevents activation, and
withheld history is never upgraded on retry. Already-archived native-auth parents
can likewise be retired without trying to reactivate them for SSH sampling.

### Boat failed-resume / uncertain-message retirement (#785)

The owner may also recover a Boat parent blocked after a failed resume followed
by an uncertain message. This is **terminal retirement**, not message retry or
conversation recovery: it fences activation, revokes delegated authority,
archives the exact recorded provider sandbox/generation, and withholds the
ambiguous unread native tail. Already mirrored history remains available.

For the parent reported in #785 (revision 5), the operator may run the following
**after the updated server is available**, setting `ORG_ID` to that parent's
organization and using its owner's existing Armada login/token:

```sh
armada_legacy orchestrator recover 1fa43284-ee2f-4602-bead-21101278e879 \
  --org "$ORG_ID" --expected-revision 5 \
  --idempotency-key issue-785-retire-revision-5 --json
armada_legacy orchestrator detail 1fa43284-ee2f-4602-bead-21101278e879 --org "$ORG_ID" --json
```

Check for a succeeded stop receipt and a stopped parent. If uncertain, retry the
**same command, key and original revision**; never issue a fresh key to bypass
uncertainty. If the revision has changed before the first attempt, inspect detail
and events rather than guessing a new revision. The provider sandbox is resolved
from fenced stored identity, never the abbreviated `b701bbd6` incident label.
These commands are documentation only; this implementation session did not run
them or touch production.

## Steer after a turn finishes

Steer targets an existing running turn; the server never implicitly starts a
new one. A provider's explicit `no_running_turn` refusal means nothing was
delivered. The steer operation settles `failed / no_running_turn`, leaves the
parent `ready`, and preserves its conversation and continuity. Fetch detail for
the new revision, then send the text as a normal message with a new idempotency
key. Replaying the original steer key and payload returns the same failed
receipt without dispatching again.

This exception is deliberately limited to steer and `no_running_turn`. Other
provider errors and the message path retain their existing conservative
handling: prompt preparation can have side effects before returning a receipt.
Generic `conflict` can mean Modal `request_outcome_unknown`; neither a
non-retryable error nor current provider idleness proves historical non-delivery.
An error after an accepted receipt is not reclassified as a refusal. Native
continuity and publication fences remain unchanged.

Ordinary sandbox steer already returns `no_running_turn` with send guidance and
releases its mutation lease for that definite refusal. Client wording is tracked
in #863 alongside the automatic same-intent send fallback owned by #847.

### Fenced event polls

`events_poll=fenced` means journal publication was rejected because the
revision, physical generation, conversation or expected provider cursor changed
between read and transaction. Owner reads and the background consumer can race
for the same cursor. Finishing a turn does not itself change these fences.
A rejected page is not acknowledged; the next poll rereads the committed cursor.

The current diagnostic does not identify which check failed. Follow-up #862
tracks closed, secret-safe reason labels; do not infer a particular mismatch
from `fenced` alone. This publication diagnostic is independent of steer's
delivery classification.

### Historical uncertain steer receipts

There is no supported in-place repair for an old receipt that persisted only
`runtime_uncertain`, without durable provider-refusal evidence. Reconcile
looks up the recorded request; Retry replays its receipt. Current idleness
cannot prove what a historical request did. `orchestrator recover` retires
compute, not an in-place repair to ready. Never edit rows or replay ambiguous
effects to infer their outcome; evidence-backed historical repair requires a
separately authorized recovery path.
