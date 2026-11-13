# Two-minute CI verdict

The owner policy in [AGENTS.md](../AGENTS.md#ci-what-we-test-and-what-we-do-not)
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
