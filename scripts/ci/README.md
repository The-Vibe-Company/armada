# Unit shards

`bun scripts/ci/unit-shards.ts --check` discovers Git-tracked Bun test filenames
and assigns every file exactly once to six nonempty shards. Stage new files
before checking locally. Run a shard with `bun scripts/ci/unit-shards.ts 1`
(through `6`). Shard 1 also runs static checks, sharing checkout/Bun/dependencies;
the planner starts each shard with its measured static reserve from
`test-durations.json` before placing tests. An omitted shard has zero reserve.
The required aggregate remains exactly `Lint, typecheck and test`.

## Refresh timing data

Refresh `test-durations.json` manually from green CI runs. Update `files` and
`workers` from the worker completion logs described below. Update `static` from
Actions step timestamps with the following command. Static steps belong between
dependency installation and runtime preparation in the unit matrix.

```sh
python3 - <<'PYTHON'
from datetime import datetime
from json import dumps, loads
from statistics import median
from subprocess import check_output

def api(path):
    return loads(check_output(["gh", "api", path]))

repo = "repos/The-Vibe-Company/armada/actions"
runs = api(f"{repo}/workflows/ci.yml/runs?event=merge_group&status=success&per_page=6")["workflow_runs"]
assert len(runs) == 6, "Expected six green queue runs"
samples = {}
for run in runs:
    jobs = api(f"{repo}/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")["jobs"]
    for job in jobs:
        if not job["name"].startswith("Unit tests ("):
            continue
        shard = int(job["name"].split("(")[1].split("/")[0])
        steps = job["steps"]
        names = [step["name"] for step in steps]
        first = names.index("Run bun install --frozen-lockfile") + 1
        last = names.index("Run bun scripts/prepare-runtime.ts")
        assert first <= last, "Expected static steps before runtime preparation"
        seconds = sum(
            (datetime.fromisoformat(step["completed_at"].replace("Z", "+00:00"))
             - datetime.fromisoformat(step["started_at"].replace("Z", "+00:00"))).total_seconds()
            for step in steps[first:last] if step["conclusion"] == "success"
        )
        print(run["id"], shard, seconds)
        samples.setdefault(shard, []).append(seconds)

assert all(len(samples[shard]) == 6 for shard in range(1, 7))
print("static =", dumps({shard: median(values) for shard, values in sorted(samples.items()) if any(values)}))
PYTHON
```

A PR that adds a static step to a shard measures it on its own CI run and raises
that shard's reserve in the same PR. Use the same jobs endpoint with the PR's
green run ID and attempt and measure the added step from its timestamps.

## Worker isolation

Each runner executes at most **two** Bun workers concurrently (no configurable
fanout). Native, driver, global-mock and other suites keep one process per file
with `--no-orphans`. Database-only core/MCP suites can share bounded workers of at most
12 files. This reuses the existing immutable migrated schema Blob, never a live
connection between suites. The measured largest bounded SQL worker used 1.57 GB
RSS locally; two fit the hosted runner's memory envelope without unbounded
parallel test discovery. The existing `github-boat.test.ts` repository-artifact
writer runs exclusively before its shard's pool; other artifact fixtures use
temporary directories. Fixture APIs and row/schema/role isolation are unchanged.
Files using explicit process/server/driver/global-mock/environment manipulation
are conservatively left isolated, as are callers of the audit helper that installs
global console spies. Imported helpers must obey the same isolation rule; this
is a reviewed SQL-suite policy, not a complete transitive static analysis. New tests are still discovered automatically;
unsupported sources fall back to their own worker. Do not add transitive native
process or global mock behavior to database-only suites; keep those contracts in
separate isolated files.

A merged worker logs its actual total (`Completed SQL worker in ...: files`),
not invented per-file durations. Single-file measurements retain the original
`Completed <file> in <seconds>s` format. Recorded weights keep raw isolated-file observations and actual SQL-worker totals
from completed CI separately. The planner schedules measured workers atomically,
preserving their membership instead of redistributing fictional per-file costs.
New/unmeasured SQL cohorts use cold-file sums minus a conservative 1.5-second
startup credit for each file after the first; estimates are never logged as measurements.
A source change requiring isolation invalidates the entire old cohort automatically.
Reviewed SQL owners include the direct migrated/row-only helpers and the existing
`database` and `harness` wrappers. Runtime fixtures/Runner/Journal suites retain
process isolation, not SQL-worker sharing. Imported helpers must
remain free of global hooks/mocks. Shared-worker savings require hosted measurements.

## Runner demand and cancellation

PR/merge-queue CI uses six unit runners plus one final aggregate (seven, formerly
ten). PR-ref concurrency keys stay stable across pushes and explicitly cancel
superseded PR runs; distinct merge-group candidates never cancel each other.
Static checks no longer pay a separate checkout/Bun/dependency installation.
Each unit runner still uses `bun install --frozen-lockfile`; no multi-gigabyte
node_modules archive is added to the critical path.

Static checks retain lint, generated iOS wire parity, strict typecheck and the
migration-version/complete-coverage guards in shard 1. Native artifact/Codex/OS
namespace contracts are publishing release checks, including exact JUnit no-skip
validation and both checkpoint process-conformance modes. No native build runs
on every PR. No required check is weakened or renamed, and no retries are added.

Before measurements and source: completed merge-queue run 43482535658. Jobs
waited 11–71 seconds; eight unit job runtimes ranged 60–90 seconds. Actual
post-change queue wait and runtime must be measured on the PR/after merge; local
worker timings or old isolated-file sums are not an observed six-shard result.
