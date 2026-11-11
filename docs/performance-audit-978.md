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

## Repeatable staging measurement procedure

From a fresh checkout, install workspace links before running chat tests:

```sh
bun install --frozen-lockfile
bun test apps/dashboard/test/chat.test.ts
```

Run the self-contained measurement script on macOS or Linux with Python 3.9+
and Bun (or pass `--cli /path/to/compiled/armada`):

```sh
# Export ARMADA_TOKEN securely first; do not put it in command arguments or logs.
export STAGING_URL=https://YOUR-STAGING-ORIGIN
export STAGING_ORG=YOUR-ORG-UUID
python3 scripts/perf/staging.py > /tmp/armada-staging-perf.json
```

This is a billable **single disposable Modal × Codex launch**, using an existing
snapshotted Modal golden (select one explicitly with `--golden NAME` if needed)
and the caller's existing Codex credential/default. It repeats only reads:
golden/list, sandbox/list, disposable sandbox detail and logs. Default 20 samples,
nearest-rank p50/p95 wall time and decoded response bytes; CLI source startup/help,
list/golden-list/detail timings are separate. It suppresses API bodies and CLI
output, never prints the token, refuses redirects and known production origins,
and requires neither GNU timeout nor util-linux.

Lifecycle phases are client-observable: idle launch-to-ready (combined server
authorization/fork/init), prompt admission, prompt-to-first-text observation
(includes admission and 500ms polling), stop and delete. A finally block attempts
stop/delete of **only the returned disposable ID**, including on interruption.
A hard kill or unknown launch outcome can prevent automatic cleanup: the script
prints a recovery ID when available; inspect staging rather than retrying an
ambiguous launch. Cleanup failure produces a nonzero exit and explicit manual
action. Ten-minute TTL bounds compute, not retained-disk lifetime.

No internal server phase breakdown or SQL round trips are exposed through these
APIs; the report marks those unavailable. Dashboard paint/navigation and actual
long-session phone-open remain unmeasured. These gaps must not be presented as
zero or inferred from synthetic CPU timing.

## Coordinator staging baseline

Source: [coordinator results on #978](https://github.com/The-Vibe-Company/armada/issues/978#issuecomment-6798001869). Script revision
`67969b0b`, macOS 27.0.1 arm64, Python 3.14.6, public internet to staging,
golden `smoke-modal`, Modal × Codex. Twenty samples per read/CLI command,
nearest-rank p50/p95; body bytes are decoded HTTP response bytes.

| API read | p50 ms | p95 ms | Response bytes |
| --- | ---: | ---: | ---: |
| golden/list | 251 | 329 | 1096 |
| sandbox/list | 335 | 663 | 22474 |
| sandbox/detail | 1750 | 2806 | 743 |
| logs/read | 1398 | 2307 | 58 |

| CLI (source) | p50 ms | p95 ms |
| --- | ---: | ---: |
| --version | 21 | 21 |
| --help | 21 | 21 |
| list | 405 | 994 |
| golden | 454 | 884 |
| detail | 1836 | 2657 |

| Single lifecycle observation | ms |
| --- | ---: |
| launch_to_ready_including_auth_fork_init | 9956 |
| prompt_admission | 2907 |
| prompt_to_first_text_observed | 8583 |
| cleanup_stop | 6315 |
| cleanup_delete | 6815 |

The disposable sandbox was deleted successfully. Lifecycle timings are one
sample, not percentiles. First text includes prompt admission and 500ms polling.

**Next measured target:** investigate `sandbox/detail` and `logs/read`, used
when opening a conversation. Their 1.75s/1.40s p50 reads substantially exceed
the sampled list routes' 0.25s/0.34s; a 58-byte logs response still takes 1.40s.
This identifies the next investigation, not its cause. Use this same script
against baseline/candidate staging revisions for the next PR's before/after.

The current PR's chat change has only synthetic CPU before/after evidence;
these staging numbers do not demonstrate its end-to-end user impact. Missing:
Boat/Claude lifecycle, resume, browser/navigation, real long-session phone-open,
internal launch subphases, complete route census and SQL trip counts. #978 stays
open. Orchestrators remain excluded.

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

1. Investigate and fix detail/logs read latency using the same staging script
   before/after. Preserve authorization, provider state and cursor semantics.
2. Conversation-open transport/render optimization selected from those traces;
   preserve pagination, ordering and cursor contracts.
3. Launch/resume critical-path optimization selected from phase data.
4. CLI startup and per-command polish, then dashboard waterfalls/bundles,
   prioritized using the same measurements.

Remaining measurement gaps stay open under #978; this first PR does not
claim completion of the entire campaign.
