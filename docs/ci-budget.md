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

The actual budget guard runs inside the required **Lint, typecheck and test**
verification aggregate, after its normal static/unit admission checks and all other
required prerequisites. The **CI budget (120s)** name is retained as an independent
fast compatibility marker pointing to that combined enforcement. Neither a second
serial runner queue nor a concurrent snapshot of an unfinished verification gate is
needed. A budget violation fails the required verification aggregate itself.
It counts elapsed
time from workflow start, including job queue/setup and aggregate gates, not just step
execution. It fails with an author-facing summary on late or unsuccessful verdicts.
It does not poll, cancel work, raise timeouts or turn skipped tests green.

## Informative recipe policy (coordinator decision, 2026-11-12)

The required Golden OS name is a fast admission gate, not a conformance verdict.
It does not depend on classification or on the full Docker job. The separate
**Informational Golden OS recipe (actual provider image)** runs on affected PRs
and always on main/manual runs; it is omitted from merge-group runs. Do not add
this informative name to the ruleset. The budget guard excludes it, even while
running or failed. It has no continue-on-error: a failure fails the main workflow
and remains visible so the coordinator can stop the merge queue.

The coordinator explicitly accepted this separation in
[issue #1269](https://github.com/The-Vibe-Company/armada/issues/1269#issuecomment-6835653366).
The cold recipe no longer holds the required verdict open. Real PR/merge-group
timings still need measurement, including runner queues. Browser sharding is the
next separate slice.
