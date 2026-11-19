# Two-minute CI verdict

The owner policy in [AGENTS.md](../AGENTS.md#ci)
supersedes the earlier CI slices (#1269, #1423). There is one required check:
`Lint, typecheck and test`, aggregating six unit shards. Shard 1 also runs lint,
typecheck and migration guards, sharing its checkout and dependency setup. No separate timing diagnostic, compatibility verdict or informational
job remains. The coordinator measures elapsed verdict time, including runner
queue/setup and aggregate overhead; exceeding two minutes is a defect to fix.

See [unit shard sizing](../scripts/ci/README.md) for the current six-shard
starting estimate and [merge queue](merge-queue.md) for the required-check policy.
Recorded durations guide sizing but do not establish actual latest-SHA verdict
time. Reduce the shard count as slow tests are removed (#1458), using hosted CI
evidence rather than a full local suite in a resource-constrained sandbox.

Real providers, goldens and full lifecycle validation belong in staging's
post-deploy smoke. Binary compilation/publication belongs in the release
workflow. Browser specs remain available through `bun run e2e`, not PR CI.

Pull request and merge-queue CI run Biome and Landmines lint, strict TypeScript
checks, migration guards, a generated iOS harness check and unit tests. The
separate Apple Quality workflow runs Swift tests and compiles the iOS apps
when app or harness inputs change. Migration preview runs for changes under `supabase/migrations`.
Keep the required verdict self-contained:
no binary, golden, image or provider build, real PostgreSQL service, browser
test, network or provider call, or retry. Native and namespace release contracts
run in publishing validation. The coordinator measures the verdict without a
timing or budget check in CI.

Keep real Git and gh installation replays, including privilege-boundary
verification, in staging smoke. Unit CI owns deterministic token renewal and
redaction at their respective boundaries.

## Import-boundary lint timing

The import-boundary guard runs inside `bun run lint`. To check its two-second
budget, compare the `Run bun run lint` step in `Unit tests (1/6)` across three
PR CI runs with the guard against the median of nearby successful runs before
the guard, using the same shard workflow and lint steps. Subtract each step's
GitHub Actions start timestamp from its completion timestamp and record the job
links, elapsed seconds and deltas in the PR body. These whole-second samples
include normal runner and change-set variation. They measure the lint step
rather than queue time or the full shard duration.
