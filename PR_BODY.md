# fix(usage): investigate missing per-sandbox usage

Closes #874

## Investigation before implementation

- The shared collector (`packages/core/src/sandbox-usage.ts`) accepts only
  `other/result` with `modelUsage` and custom `other/armada/turnUsage`.
  Counting a `prompt` event is independent, explaining how turnCount can be
  nonzero while turns is empty.
- A successful **real local Codex exec** run produced `turn.completed` with
  snake-case `usage`: input_tokens, cached_input_tokens,
  cache_write_input_tokens, output_tokens, reasoning_output_tokens.
  The collector does not handle this shape. This is NOT yet evidence of
  Boat's transport envelope, nor of Modal's app-server stream.
- Boat preserves unrecognized event data as `other`, but converts response
  events into messages and keeps only content/model/tool fields. Usage in a
  response envelope would be dropped. We cannot establish that this is the
  production envelope without a recording.
- Modal returns stored AgentEvents unchanged. The runtime Claude driver emits
  final result frames; its Codex app-server driver converts cumulative
  thread/tokenUsage/updated totals into per-Armada-prompt deltas. A resumed
  thread without an in-memory baseline intentionally yields null token counts.
  Cache-write/reasoning fields are not currently collected.
- The runtime SQL intentionally returns null for open compute intervals and
  pre-migration rows. Both provider paths also invalidate compute history when
  a stop lacks a provider timestamp. Explicit stop calls use a local timestamp
  for stopped_at but still mark usage runtime unknown without provider evidence.
  A production row/history is needed to distinguish these causes in the example.
- No child usage aggregation is currently exposed on orchestrator detail.

## Current delivery state: INCOMPLETE / DO NOT MERGE

Only the successful Codex terminal recording and its provenance are committed.
No production behavior has been changed. No synthetic sample is represented
as a real stream. Successful Claude usage and Boat envelope recordings are
blocked by separate sandbox authentication failures (Claude: Not logged in;
Boat events: HTTP 401). GitHub access is disabled as agreed.

## Remaining acceptance work

- Obtain successful Claude and actual Boat event envelopes; replay both
  harnesses through the owning adapter/runtime boundary.
- Preserve and normalize reported turn fields, including cache-write and
  reasoning; expose null-safe sandbox totals.
- Fix the confirmed lifecycle cause without estimating unobserved intervals.
- Expose parent own usage and child sums on orchestrator detail, preserving
  visibility rules.
- Exercise status/list/detail after one finished turn and run full local
  verification and independent review of the completed fix.

## Legacy sandboxes

No backfill is planned. Existing compute histories that are unknown remain
unknown; old token history is recoverable only if retained events actually
contain reported usage. Do not synthesize zero usage for missing reports.

## Production check for coordinator after implementation

For each provider (Boat and Modal), launch one Claude and one Codex sandbox
from an authorized golden with a minimal prompt. Wait for the turn to finish.
Read status, list, and detail as the owner: verify per-turn model and reported
input/output/cache/reasoning fields, consistent sandbox totals, and no quota
events counted as tokens. Stop each sandbox and verify compute seconds for
the recorded interval. Repeat with an orchestrator parent and one child:
verify parent own usage is separate from child sums and that another user
cannot read private usage. Check a pre-fix sandbox remains explicitly unknown
where history is incomplete. Never print credentials or raw account reports.

## Local verification completed

- `bun install --frozen-lockfile`: passed.
- `bun test packages/mcp-server/test/sandbox-usage.test.ts`: 2 passed,
  0 failed (existing baseline tests; they do not prove the requested fix).
- `git diff --check`: passed.
- No migrations, deployment, production access, push or PR creation.
- Independent review/full verification of the fix has not run because the fix
  is not implemented and mandatory stream evidence is still unavailable.
