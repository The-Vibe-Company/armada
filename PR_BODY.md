# fix(usage): report live runtime and complete reported token totals

Closes #874

## Investigation (before implementation)

The coordinator recorded one successful trivial turn ("Reply with exactly: OK")
on Boat/Claude, Boat/Codex and Modal/Codex. The two Boat public event streams
contain only prompt + message. Modal emits `armada/turnUsage` and already
reports 13136 input / 5 output tokens. Recorded event arrays/excerpts and
provenance are checked in; the locally captured native Codex exec terminal is
explicitly NOT claimed to be a Boat envelope or Modal app-server notification.

### Boat: missing upstream per-turn telemetry, not a different result parser

Inspected installed `@boatdev/sdk@1.13.0`:
- `src/apis/BoatApi.ts:eventsRaw/events` reads `GET /sandboxes/{id}/events`;
  `src/models/SandboxEvent.ts:SandboxEventFromJSONTyped` preserves the complete
  arbitrary `data` object. The SDK does not strip token fields.
- Armada's `packages/provider-boat/src/events.ts` preserves unknown events
  whole as `other`. Known response events project text/model/tools only.
  It would discard undocumented usage inside a response, but the supplied
  recordings are already normalized, so they cannot prove whether any such
  raw fields existed. No parser for a guessed shape has been added.
- The [documented events API](https://docs.boat.dev/api/reference/agent/list-sandbox-events)
  promises work/lifecycle/progress, text/streaming/tool events. Its extensible
  data is not a documented raw Claude/Codex stream and offers no raw-harness
  mode or per-turn usage contract. No native result/token_count event is
  present in the actual public recordings.
- Boat has a separate [sandbox AI usage API](https://docs.boat.dev/api/reference/ai-credentials/get-sandbox-ai-usage),
  also present in this SDK, but it is **proxied** usage grouped by UTC day,
  credential and model: not per prompt and not a source for subscription
  harness counts. Never attribute a day's total to one turn.
- SDK `usage()` separately returns multiplier-weighted billable machine
  seconds. That meter is not interchangeable with Armada elapsed runtime.

**Boat limitation remains explicit:** these public recordings contain no
reported token usage; turns stays empty and token totals stay null, not zero.
To meet the original Boat non-empty per-turn criterion, capture authenticated
native usage inside the sandbox before Boat projects messages, correlate it
to Armada prompt IDs and report it through a scoped channel. This belongs
with the in-sandbox reporter in #878, not a guessed response-field parser.
An authenticated raw Boat API capture could additionally rule out undocumented
fields; this sandbox cannot perform that check (Boat credentials unavailable).

### Modal and compute

Modal's event store preserves AgentEvents, and the native Claude driver emits
final `result.modelUsage`. Codex's app-server driver emits custom usage by
subtracting the previous thread-total baseline. Native exec `turn.completed`
is a different transport and is not used to “fix” Modal.

The SQL helper from #773 deliberately returned null for every **open**
compute interval on both providers, even with a known running-since boundary.
Finishing a model turn does not stop the machine, so all three supplied
finished-turn observations are consistent with that bug. The migration now
reports completed + current measured Armada-observed elapsed seconds.
Legacy/missed transitions and external stops without provider timestamps
remain unknown rather than inventing an endpoint. This is not CPU time or
provider billing. A raw stopped production row was not supplied, so the cause
of any particular stopped legacy row cannot be asserted from these captures.

## Changes

- Live runtime is visible on existing status/list/detail SQL reads for both
  providers. Completed stop/resume accumulation and visibility remain intact.
- Preserve reported Claude cache-creation and Codex cache-write/reasoning
  fields; unsupported fields remain null. The Codex transport test verifies
  optional fields and cumulative delta/restart behavior.
- Add `usage.tokenTotals` to status/list metadata. A missing turn or token
  field makes that total unknown, not a falsely complete subtotal.
- Persist parent usage atomically with orchestrator event ingestion.
  Orchestrator detail exposes `usage.own` separately from `usage.children`
  summed compute/turn/token values. Unknown children propagate unknown
  components; empty child sets sum to zero. Reads retain owner/org fences.

## Legacy behavior / deployment

No backfill. Recorded token observations can be read with new totals;
unreported fields stay null. Legacy compute histories stay null. Persisted
child totals reflect the last collected status observation; detail does not
perform a new unbounded provider history scan. Apply the new migration
`20261110190000_sandbox_usage_live_runtime.sql` through normal deployment
before running the new server. No production migration/deployment was performed.

## Verification

- `bun packages/agent-runtime/build.ts` and
  `bun scripts/validate-runtime-native.ts`: passed.
- `bun run verify`: passed (lint, both strict TypeScript projects,
  **1604 passed / 20 opt-in skipped / 0 failed**, 239 test files).
- Independent review-code-dev v2.1.0 / OCR1.12.1: **22/22 files reviewed,
  no findings**; committed file hashes match reviewed candidate.
- First broad run failed because portable preparation lacked Linux-native
  resources and serve HTTP observed 14 terminations instead of13. Native
  build fixed the former; isolated baseline/candidate retries and the complete
  final run passed the latter. No tests were weakened.
- `git diff --check`: passed.
- Head: `16351a28e0e0b8beddc0383d3acca0f99b231144`.
- Evidence: `plans/ship-pr-dev/runs/874-local/` (ignored local artifacts).
  GitHub push/PR/CI are delegated to the coordinator; the sandbox token is dead.
- New migration is greater than the highest locally available origin/main
  migration (20261110180000). Check current remote main for timestamp collision
  before transporting/pushing; no remote version claim is made.

## Coordinator production check

1. Apply migration through the authorized deployment process. For each
   provider, launch one Claude and one Codex sandbox with a trivial prompt.
   Wait for completion; read status, list and detail as owner.
2. Verify computeSeconds is non-null while recorded machines are running;
   explicit stop with a provider timestamp freezes the completed interval.
   Missing/legacy boundaries must remain null. Compare elapsed time only,
   not multiplier-weighted Boat billing seconds.
3. On Modal, verify reported model/input/output/cache fields and tokenTotals;
   missing reasoning/cache-write values must stay null, not zero. On Boat,
   verify the documented limitation (empty turns/null tokens) until #878
   supplies native reports. Non-empty Boat token acceptance is not claimed.
4. Run an orchestrator and one child. Verify own usage remains separate from
   child totals after event ingestion/status collection, replay does not
   double-count, and a non-owner cannot read private usage.

### Additional native protocol confirmation

A successful local real Codex app-server turn was captured after the initial
investigation (initialize → thread/start → turn/start). Its
`thread/tokenUsage/updated.tokenUsage.total` contained `inputTokens: 16837`,
`outputTokens: 5`, `cachedInputTokens: 0`, `cacheWriteInputTokens: 16834`,
`reasoningOutputTokens: 0`. This confirms the optional camel-case field names
used by the driver; unlike the earlier native exec frame, it is the same
transport used by the Modal runtime. Only the counter snapshot was retained
in the ignored local validation evidence; no auth/account payload was saved.
