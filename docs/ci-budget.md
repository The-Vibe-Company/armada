# Two-minute CI verdict — slice 1 (#1269)

Required names to retain:
- Migration versions
- Lint, typecheck and test
- Golden PostgreSQL concurrency
- Golden OS recipe (actual provider image)
- Binary (linux-x64), Binary (linux-arm64), Binary (darwin-arm64)

Coordinator ruleset changes: **remove Binary (darwin-x64)** and **add CI budget (120s)**.
Intel macOS still builds/tests on main, manual runs, and the unchanged release workflow.

PR and merge-group expensive checks compare the entire candidate against its event
base. Both conservatively depend on all packages (including CLI/server entrypoints,
shared core, providers and runtime artifacts), migrations (embedded binary schema
version), the lockfile/root package/tsconfig, build/npm/runtime/image scripts, fixtures,
local actions and CI workflow. Dashboard-only and documentation-only changes report
the existing required names without building. Main/manual runs always build everything.
A classifier failure cannot produce a green budget gate.

The budget guard takes a single API snapshot after the required jobs, counting elapsed
time from workflow start, including job queue/setup and aggregate gates, not just step
execution. It fails with an author-facing summary on late or unsuccessful verdicts.
It does not poll, cancel work, raise timeouts or turn skipped tests green.

## Measurement limitation

Path gating removes expensive work for unrelated changes; it cannot make a cold
affected Golden OS Docker build (previously 3.1 minutes) finish in 120 seconds.
The new guard deliberately exposes that violation rather than claiming timeout or
skipping relevant tests satisfies the owner rule. Real PR and merge-group timings
must be measured before accepting this slice; runner queue delays are also outside
the repository's control. Slice 2 (browser sharding) must wait until slice 1 merges.
