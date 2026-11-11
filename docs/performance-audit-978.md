# Performance audit #978 — first slice

Feature freeze: no new runtime capability. This first slice removes repeated
array copying while projecting legacy streamed conversation chunks. Each chunk
previously copied all earlier unfinished chunks of its turn (quadratic work).
The array is private to one projection; appending preserves ordering and the
existing final-message supersession behavior.

## Reproduce

Run `bun scripts/perf/chat.ts 30` on each revision with the same Bun version,
machine and workload. Copy the script to the baseline checkout before running.
Three warm-ups, 30 timed projections per cell; nearest-rank p50/p95, milliseconds.
Fixtures are constructed outside timing. Results include runtime, architecture,
sample count and visible item counts. No network, credentials or provider usage.
This measures warm projection CPU only, **not** browser conversation-open time,
DOM rendering, transport or the owner's reported ~10 seconds on the phone.
Existing chat projection tests own ordering, turn isolation and final-snapshot
supersession; no timing assertions are added to CI.

## Scope exclusion

Per the owner decision on #978 (2026-11-11), orchestrators are out of scope:
do not audit, test, polish or change their implementation, dashboard or iPhone
screens. A separate ticket owns feature removal. All backlog items below apply
only to non-orchestrator paths.

## Audit / measurement backlog

These are code-inspection leads, not measured bottleneck claims. Do not rank
provider waits against CPU numbers until staging traces exist.

| Path | Current inspection / next measurement |
| --- | --- |
| Launch, Boat/Modal × Claude/Codex | Trace `packages/core/src/launch.ts` phases: authorization, credentials, fork, init, MCP, beforeStart, prompt admission; report time-to-ready and first output separately. Requires staging accounts/goldens and explicit resource budget. |
| Stop/resume | Measure provider restore and first new prompt separately, preserving conversation/disk identity. Inspect provider adapters and `mcp-lifecycle.ts`. |
| API routes | Inventory dispatchers in `control.ts`, `http.ts` and dashboard `app/api/**/route.ts`, plus iOS control client callsites. Record per route/method p50/p95, bytes, SQL round trips under a fixed staging dataset and caller visibility. Never infer SQL counts from HTTP timing. No staging route census completed here. |
| Dashboard load/navigation | Capture authenticated staging browser waterfalls, first paint blockers, build bundle sizes and repeated fetches for each page. No browser/network performance claim in this slice. |
| CLI | Benchmark compiled binary and source separately: version/help, list/detail/logs and mutations with fixed staging fixtures. Separate startup from server latency. No CLI optimization claim here. |
| Long conversation open | `sandbox-chat.tsx` drains event pages serially then repeatedly projects accumulated history; `events.ts` merges by ID, `chat.ts` projects all retained events. This PR measures only legacy chunk accumulation. Next compare provider pagination, transport bytes, projection and render on a real long session on phone. |
| Indexes / query duplication | Inspect staging SQL plans and round-trip counts before proposing migrations or parallelism; authorization and revocation must remain unchanged. |

## Proposed next small PRs

1. Staging baseline harness and route census: read-only timings/bytes plus SQL
   instrumentation evidence; provider lifecycle measurements only with approved
   disposable fixtures. Establish the biggest user-visible wait.
2. Conversation-open transport/render optimization selected from those traces;
   preserve pagination, ordering and cursor contracts.
3. Launch/resume critical-path optimization selected from phase data.
4. CLI startup and per-command polish, then dashboard waterfalls/bundles,
   prioritized using the same measurements.

Missing staging measurements remain open under #978; this first PR does not
claim completion of the entire campaign.
