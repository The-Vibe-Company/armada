# Separate dispatch scaffolding from handler work (#978)

Coordinator after #1017: status dispatch p50 245ms already contains authorized
sandbox lookup 16ms, stored provider setup 102ms and state projection 106ms.
Logs dispatch 207ms contains target resolution 116ms and events 75ms. These are
inclusive intervals, not evidence of a 200ms MCP framework tax. Median phase
values should not be added/subtracted as though they were a single sample.

## Local measurement before changing architecture

Repeatable, offline, no SQL/provider/auth calls:

```sh
bun scripts/perf/dispatch.ts 30
```

The script runs the real server registration, in-memory MCP client/server
negotiation, validated empty-org golden_list call and cleanup. Three warmups,
30 samples, nearest-rank p50/p95. The database/provider ports throw if touched.
Copy the script to baseline to compare the identical method.

Sequential Ubuntu x64 / Bun1.4.2 runs on this sandbox, baseline ea517c3b:

| Local empty-tool total | p50 ms | p95 ms |
| --- | ---: | ---: |
| Before phase instrumentation | 1.42 | 2.99 |
| After phase instrumentation | 1.39 | 3.13 |

After per-phase p50: register 1.11ms, connect 0.19ms, handler 0.07ms, cleanup
0.01ms. Other local runs varied (roughly1.5–3.4ms total). This is not a speedup
claim, a CPU-isolated benchmark or a staging/server/client latency estimate.
It does not justify bypassing MCP validation or caching an authenticated caller.

## New server evidence

The real API tool bridge now reports:
- tool_register: per-request tool/schema registration.
- tool_connect: client/transport construction plus negotiation.
- tool_call: tool execution and protocol validation, including nested SQL/provider
  work. It is not pure overhead.
- tool_close: client/server cleanup, still executed in finally on errors.

These fixed names contain no argument/identity/credential values. Timing does
not change auth, input/output validation, error mapping, ordering, retry policy
or the660s timeout. No session/caller cache. Direct routes such as logs/read do
not use this bridge and correctly have no tool_* phases. Nested handler phases
must not be added to tool_call/dispatch; separate percentile sums are not totals.

The same macOS-compatible staging script records all four phases in serverMs.
Coordinator after merge/deploy, same host/network/org/fixture:

```sh
bun install --frozen-lockfile
# Securely export STAGING_URL, STAGING_ORG and ARMADA_TOKEN as before.
python3 scripts/perf/staging.py --samples 20 --golden smoke-modal > /tmp/armada-dispatch-after.json
```

Post deployed SHA/full JSON on #978; confirm cleanup.deleted=true. One disposable
Modal × Codex launch, as before. This diagnostic PR deliberately does not rewrite
millisecond scaffolding in pursuit of a misattributed200ms. Use staging phases
to choose any further real overhead reduction; launch-to-ready phases are next.
No migrations, orchestrator-specific work or production operations.
