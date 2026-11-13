# Two-minute CI verdict — slice 1 (#1269)

Required names to retain:
- Migration versions
- Lint, typecheck and test
- Golden PostgreSQL concurrency
- Golden OS recipe (actual provider image)
- Binary (linux-x64), Binary (linux-arm64), Binary (darwin-arm64)

Coordinator ruleset changes: **remove Binary (darwin-x64)** and **remove CI budget (120s)**.
Intel macOS still builds/tests on main, manual runs, and the unchanged release workflow.

PR and merge-group expensive checks compare the entire candidate against its event
base. Both conservatively depend on all packages (including CLI/server entrypoints,
shared core, providers and runtime artifacts), migrations (embedded binary schema
version), the lockfile/root package/tsconfig, build/npm/runtime/image scripts, fixtures,
local actions and CI workflow. Dashboard-only and documentation-only changes report
the existing required names without building. Main/manual runs always build everything.
A classifier failure cannot produce a green budget diagnostic.

## Non-required timing diagnostics (urgent coordinator decision, 2026-11-13)

**Lint, typecheck and test** depends only on the real verification jobs and
checks every dependency's result. It never depends on or executes the budget
check. Runner timing cannot turn successful code checks red.

**CI budget (120s)** is a separate, visible, **non-required** job on PRs and merge
groups, after the required verdict and its prerequisites. **Remove this name
from the ruleset if present.** Its own runner queue, checkout, API calls and setup
are not admission latency: the script measures the latest completed required-path
verdict minus workflow start, including the required aggregate. Only known
required-path names participate; informational Golden OS, Intel macOS, unrelated
informational jobs and the budget job itself are ignored. A late required path
still fails this diagnostic and writes its summary, without failing the required
gate. No threshold increase, polling or test/assertion weakening.

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
