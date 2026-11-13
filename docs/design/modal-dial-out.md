# Modal: converge on the common runtime transport (#1421)

## Current state

Modal already runs Armada's harness drivers, not a Modal prompt API. The remaining
split is delivery, control transport and lifecycle authority:

- `packages/provider-modal/src/distribution.ts` installs the bundled Node runtime;
  `runtime-overlay.ts` verifies/updates it on fresh-machine preparation.
- `provider.ts` owns physical machines, binding, generations, bootstrap health,
  stop/restore, snapshot exclusion and process quiescence. These are host lifecycle
  responsibilities and must survive the transport replacement.
- `transport.ts` sends request envelopes through an authenticated Modal tunnel.
  `packages/mcp-server/src/modal-integration.ts` constructs scoped generation
  grants, resolves immutable App/environment credentials and ingests events through
  `/api/internal/modal/events`. The runner receives private bootstrap configuration.
- `packages/agent-runtime/src/main.ts` serves the listener and common harnesses:
  Codex, Claude Code and OpenCode. GitHub, MCP, skills, model auth, follow-ups,
  usage and lifecycle behavior must not disappear when the listener does.

Boat/Docker's enrolled path already supplies a compiled runtime, digest-verified
artifact/harness caches, private single-use enrolment, epochs, WebSocket with HTTPS
fallback, durable command results and acknowledged journal batches. See
[`docs/runtime-startup.md`](../runtime-startup.md). Today its selected harness is
Codex; selecting Modal must not imply Claude/OpenCode parity without implementing
and checking their enrolled configuration and driver admission.

## Target and boundaries

Keep Modal as the machine provider: immutable workspace/environment/App binding,
provider credentials, golden/image creation, stdin exec, storage, stop/restore and
delete. Feed that host into the **existing** runtime bootstrap/startup, enrolment,
command and event services; do not create a Modal mailbox, journal or second
runtime. Never map a Modal image to a Boat golden or accept a host ACK as health.

The initial staging opt-in is explicit and default off, frozen per sandbox using
shared core contracts and accepted by every client parser in the same code PR.
It is a temporary migration gate, not another permanent launch mode. Non-opted-in
Modal launches keep their behavior until cutover; opted-in failures never fall
back to the tunnel. No credential values in argv, images, receipts or logs.

Before coding the first launch, inspect the Boat-specific admission guards in
runtime enrolment/events/commands and launch preparation. Generalize only the
necessary host discrimination, keeping owner/membership, expiry, lifecycle and
current-epoch checks. Modal machine generations remain host lifecycle fences;
new runtime epochs are issued on each process start/resume, not substituted for
physical generation. Failed/late startup must revoke authority and stop compute.

## Independently mergeable order

1. **This design only.** Post this note and the parity table on #1421. No runtime
   behavior change, migration, staging allocation or deletion.
2. **One Codex answer.** Add the explicit staging gate, persisted routing, Modal
   stdin bootstrap of the matching compiled artifact, enrolled health and common
   prompt/archive routing. Include the minimum enrolled checkpoint/ACK and stop
   fencing: current Modal stop requires a tunnel checkpoint and native-ingest
   watermark; an opted-in stop must use the common runtime checkpoint/archive
   instead, without depending on the old listener. Resume parity stays in slice 3.
   Reuse model-account resolution and existing caches.
   Scope explicitly to a golden checkout as-is if setup parity is not yet ready;
   refuse unsupported preparation rather than silently ignoring it. Add offline
   adapter/startup tests and a one-allocation Modal check. No allocation retry.
3. **Lifecycle and setup parity.** Follow-ups, steer/interrupt, stop/restore with a
   fresh epoch and preserved journal/session, GitHub, MCP, skills/default receipts,
   variables/secrets, subscription auth and truthful usage/cost. Reuse the #1161
   implementation rather than editing files owned by its open PRs. Extend the
   same Modal smoke rather than requesting independent billable feature launches.
4. **Harness parity and default.** Admit Claude/OpenCode through the same enrolled
   configuration/command path, with parser coverage and real lifecycle evidence.
   Coordinator flips staging, then production; record exact revision and times.
5. **Delete only after authorization.** After coordinator-recorded production
   default-on operation for one day, remove the Modal tunnel control transport,
   listener bootstrap/config/grants, Modal-only event ingestion and obsolete
   bundled-runner delivery/callers/tests. Preserve machine management, binding,
   snapshots, SSH/human access and provider exec needed for bootstrap. Delete
   shared listener code only when no remaining consumer needs it. No deletion
   or production cutover is authorized by the design or first-answer PR.

Every slice uses `Refs #1421`; only the final accepted deletion closes the issue.

## Acceptance evidence and coordinator checks

**This PR's single staging check:** none (documentation only). Coordinator reviews
this plan against #1421; it does not claim provider acceptance.

For slice 2, ship an exact command/runbook in that PR before requesting a check:
use existing staging origin/login/org/Modal golden/Codex account; preflight gate
support before allocating, create exactly one Modal sandbox, send a unique literal
answer prompt, require current enrolled epoch and prompt ID, and require the
non-partial assistant answer plus finished event from `source:armada-runtime`.
Stop that sandbox once and verify stopped metadata. Selection metadata, native
Modal ingest or a synthetic transport result is not inference proof. No new
credentials, worker staging access or manual artifact publication is required.

Later slices extend this same coordinator-owned Modal lifecycle smoke with the
rows below. Record unknowns honestly; server deployment and unit tests are not
staging passes. Measure matched cold/warm/resume launch time; call out a >20%
regression for an owner decision. Never retry an uncertain allocation or command
with a new identity. Archive reads must continue while stopped without compute.

| Feature | Tunnel today | Dial-out at design slice | Required check |
| --- | --- | --- | --- |
| Codex first prompt | implemented; not rerun here | not wired for Modal | nonce answer + finished from archive |
| Follow-up, steer/interrupt | implemented; not rerun | not verified on Modal | same-session answer, steer/cancel events |
| Stop/restore | implemented; not rerun | not verified on Modal | epoch advances; old epoch denied; history retained |
| GitHub | implemented; not rerun | not verified on Modal | current-epoch acquisition and authenticated repo operation |
| MCP | implemented; not rerun | not verified on Modal | tool/arguments/result provenance in archived prompt |
| Skills/defaults | implemented; not rerun | not verified on Modal | effective default pins match launch/status receipts |
| Variables/secrets | implemented; not rerun | not verified on Modal | authorized delivery; no values in logs/archive |
| Usage/cost | implemented; not rerun | not verified on Modal | harness totals + admitted pricing, missing stays unknown |
| Subscription auth | implemented; not rerun | not verified on Modal | broker refresh/access; revoked epoch denied |
| Claude/OpenCode | implemented; not rerun | not admitted by this slice | each harness lifecycle through common archive |

## Later

Multi-tenant hardening beyond existing authorization, new host capabilities and
unrelated runtime options are out of scope. No provider-runtime compatibility
layer, new proxy service or speculative transport abstraction is planned.
