# Two-minute CI verdict — slice 1 (#1269)

Required names to retain:
- Migration versions
- Lint, typecheck and test
- Golden PostgreSQL concurrency
- Binary (linux-x64), Binary (linux-arm64), Binary (darwin-arm64)

Coordinator ruleset changes: **remove Binary (darwin-x64), Golden OS recipe (actual provider image), and CI budget (120s)**. Do not add the informational Golden OS name. The required verification aggregate owns budget enforcement; echo-only compatibility jobs are removed to save runners.
Intel macOS still builds/tests on main, manual runs, and the unchanged release workflow.

PR and merge-group expensive checks compare the entire candidate against its event
base. Binary checks conservatively depend on all packages (including CLI/server entrypoints,
shared core, providers and runtime artifacts), migrations (embedded binary schema
version), the lockfile/root package/tsconfig, build/npm/runtime/image scripts, fixtures,
local actions and CI workflow. Dashboard-only and documentation-only changes report
the existing required names without building. Main/manual runs always build everything.
A classifier failure cannot produce a green budget gate.

The budget guard runs inside required **Lint, typecheck and test**, after every
required prerequisite. All prerequisite results must succeed, on main as well as
PRs. Path classification shares the migration-validation runner. No echo-only
Golden OS or budget marker job remains. Lint and typecheck already share one job.
It counts elapsed
time from workflow start, including job queue/setup and aggregate gates, not just step
execution. It fails with an author-facing summary on late or unsuccessful verdicts.
It does not poll, cancel work, raise timeouts or turn skipped tests green.

## Informative recipe policy (coordinator decision, 2026-11-12)

The full **Informational Golden OS recipe (actual provider image)** runs on
affected PRs and always on main/manual runs; it is omitted from merge-group runs.
There is no required Golden OS admission marker. The budget guard excludes the
informational job, even while running or failed. It has no continue-on-error:
a failure fails the main workflow and remains visible so the coordinator can stop
the merge queue. Recipe inputs are runtime sources/artifacts, Modal provider and
shared core sources, the Boat GitHub SSH bootstrap, the three OS conformance tests, recipe generator/fixtures,
lockfile/root package/tsconfig, setup actions and this workflow. Unrelated API test
files and migrations no longer trigger the Docker build.

The coordinator explicitly accepted this separation in
[issue #1269](https://github.com/The-Vibe-Company/armada/issues/1269#issuecomment-6835653366).
The cold recipe no longer holds the required verdict open. Real PR/merge-group
timings still need measurement, including runner queues. Browser sharding is the
next separate slice.

## Runner headroom (2026-11-12)

Unit shards are reduced from twelve to seven; every discovered file still runs
exactly once. Weights are refreshed after the fixture-restore changes, not copied
from the old twelve-shard baseline. The measurement includes test/hook execution;
runner allocation, checkout, install, runtime build and PostgreSQL startup still
need their own headroom. Real PR/merge-group deadline enforcement remains 120s.

Required-lane job count drops from 22 to 14 per merge-group run (seven unit,
static, migration/classification, three binaries, PostgreSQL conformance and
verification). A recipe-affected PR adds one informational Docker job; main adds
that job and the Intel binary. No echo-only marker job is retained.

The organisation API available to the delivery agent returns `plan: null`, not an
Actions concurrency limit. An administrator must confirm that limit; do not infer
it from paid minutes or assume the public Free/Team default. With limit `L` and
`R` slots reserved for PRs/other workflows, a conservative queue cap is
`floor((L - R) / 14)`. Keep the coordinator's temporary queue cap of two until
that capacity is confirmed. Browser measurement jobs in the stacked PRs also
consume this shared pool; a smaller unit matrix alone cannot guarantee headroom.

Local serial baseline on merged main: 352 discovered files, 369.99s wall,
370.306s summed JUnit suite times (the latter includes overlapping suite bookkeeping).
Six dashboard files hit an incomplete local Next installation and were revalidated
after restoring that installation from Bun's existing cache: all 448 dashboard
tests passed. Those unmeasured files retain the planner's conservative 1s default.
With refreshed weights, seven LPT shards estimate 53.75–53.76s each. Six shards
would need at least 62.7s of tests; allowing 30s for runner/setup/SQL leaves no
90s headroom. Seven is the smallest count under that allowance (about 84s).
This is a sizing estimate, not a claim of observed GitHub runner timing; the live
120s guard remains authoritative for PR/merge-group admission.

Fresh local shard validation (up to three processes on a four-CPU sandbox): all
seven pass; observed test-process walls were 56.70s, 36.71s, 59.59s, 70.08s,
56.71s, 58.53s and 40.81s. Shard two's first attempt reproduced the known
managed-REST broker test timeout at 5000ms. Its original cases now run in three
separate contract groups (canonical requests, endpoint denial, prefix denial),
with unchanged assertions and timeout, no retries. The repaired shard passed;
this is a code correction, not a retry-based flake policy. These local test walls
exclude GitHub service/setup/runner queue time and are not a two-minute CI claim.
