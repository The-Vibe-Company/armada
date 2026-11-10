# Orchestrator create failures and uncertain receipts

An admitted `create` returning `runtime_uncertain` is not proof of allocation,
non-allocation, or an agent/model failure. The receipt is durable; its original
key must not be replaced to work around uncertainty. Ordinary `armada list`
intentionally excludes managed orchestrator parents, including from their owners.
Use the owner orchestrator endpoints instead.

## Read-only incident capture

With the existing owner session or `ARMADA_TOKEN` already in the host environment:

```sh
armada orchestrator detail ID --org ORG --json
armada orchestrator events ID --org ORG --json
armada orchestrator capabilities --json
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
specific Modal case with **no public sandbox/conversation binding** and an
uncertain first create, the owner can explicitly recover through Armada:

```sh
armada orchestrator recover ID --org ORG --expected-revision ORIGINAL_REVISION \
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

A **fresh create name/key is another allocation**, not an idempotent retry. It is
safe from duplicating this original resource only after exact recovery succeeds.
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
