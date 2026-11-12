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

Unit shards are reduced from twelve to **eight**. Every discovered file still
runs exactly once. Each file runs in its own Bun process, with `--no-orphans`:
regrouping files exposed a stuck native-driver test that passed on its own;
Bun's fresh-global `--isolate` mode did not reliably remove the native hang.
Process isolation preserves all assertions and avoids contaminating later files
with runtime/native state. A failed file does not prevent remaining files from
running, and any nonzero child exit fails the shard. There are no retries or
raised test timeouts.

Weights now measure complete per-file subprocess wall time, including cold
imports, setup and teardown, not only the sum of test bodies. The scheduler logs
`Completed <file> in <seconds>s` so these can be refreshed without API polling.
New files still receive a conservative 1s estimate, and the coverage guard checks
disjoint, exhaustive assignment.

### Measurement and sizing

A disposable Ubuntu 24.04 container supplied ordinary Git/gh/sudo/Node/Python,
with no host HOME or credential environment and networking disabled. This avoids
sandbox launchers injecting live credentials into offline process-boundary tests.
Each container had two CPUs and 4 GiB; at most two containers ran concurrently.
All 352 files passed with process isolation. Seven baseline shard walls were
61, 63, 66, 68, 66, 57 and 52 seconds. Measured per-file walls totalled **433.923s**.

Refreshed longest-processing-time assignment estimates:

| Shards | Slowest test-process load | With 30s runner/setup/SQL allowance |
| --- | --- | --- |
| 6 | 72.323s | 102.323s |
| 7 | 61.991s | 91.991s |
| **8** | **54.243s** | **84.243s** |
| 9 | 48.216s | 78.216s |

Eight is the smallest count with headroom under ~90s using that allowance.
This is sizing evidence, not a claim of measured GitHub PR/merge-group latency.
The 120s guard still counts queue/setup and the verification aggregate.

### Required names and capacity

Required-lane job count drops from **22 to 15** per merge-group run (eight unit,
static, migration/classification, three binaries, PostgreSQL conformance and
verification). A recipe-affected PR adds one informational Docker job; main adds
that job and the Intel binary. Lint and typecheck already share one runner. No
marker-only Golden OS or budget job remains; the ruleset changes above are needed.

The organisation API available to this delivery agent returns `plan: null`, not
an Actions concurrency limit. An administrator must confirm the actual limit;
do not infer it from paid minutes or assume a public Free/Team default. With
limit `L` and `R` slots reserved for PRs/browser/other workflows, a conservative
queue cap is `floor((L - R) / 15)`. The coordinator's temporary cap of two is not
proven safe without that capacity information. Browser measurement jobs in the
stacked PRs also consume the shared pool; do not promote the browser gate before
both capacity and full PR/merge-group timings are verified.

Final eight-shard validation repeated all **352 files exactly once**, with all
child exits successful. Test-process walls were **45, 52, 48, 47, 49, 52, 67 and
68 seconds** under the same container limits. These are not GitHub job walls:
setup/service initialization, queue allocation and the final aggregate still
need verification in the PR/merge-group runs. No 90s/120s live-CI claim is made
from the local sizing model.
