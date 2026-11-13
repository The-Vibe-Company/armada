# Unit shards

`bun scripts/ci/unit-shards.ts --check` discovers Git-tracked Bun test filenames
and assigns every file exactly once to eight nonempty shards. Stage new files
before checking locally. Run a shard with `bun scripts/ci/unit-shards.ts 1`
(through `8`). Each file runs in an isolated Bun process with `--no-orphans`.
New files receive a one-second estimate; recorded weights in
`test-durations.json` drive deterministic longest-first placement.

Eight shards are the owner-approved immediate response to merge-queue verdicts
exceeding two minutes (#1458). Weights were refreshed from completed merge-queue
run 43457010784 (per-file `Completed ... in ...s` lines). That run's six shard
jobs took 85, 69, 111, 94, 85 and 116 seconds respectively, including setup.
The eight-way refreshed plan predicts about 58.1 seconds of measured file work
per shard, before setup and aggregate overhead. This is a projection, not an
observed eight-shard result: the coordinator measures after merge, targeting
shards under 75 seconds and verdict under 110 seconds. Keep deleting slow tests
so the repository can return to six shards when measured CI permits it.

`Lint and typecheck` owns lint, strict typecheck, migration-version validation
and the native artifact/process contracts, which portable unit fixtures do not
prove. Unit shards prepare the portable runtime. No real PostgreSQL service,
provider image, binary publication or browser measurement runs in this workflow.
Database-dependent cases remain available for explicit integration runs; they
are not CI unit evidence. The aggregate depends only on static checks and units
and rejects failures, skips and cancellations. See the CI policy in AGENTS.md.
