# Unit shards

`bun scripts/ci/unit-shards.ts --check` discovers Git-tracked Bun test filenames
and assigns every file exactly once to six nonempty shards. Stage new files
before checking locally. Run a shard with `bun scripts/ci/unit-shards.ts 1`
(through `6`). Each file runs in an isolated Bun process with `--no-orphans`.
New files receive a one-second estimate; recorded weights in
`test-durations.json` drive deterministic longest-first placement.

The recorded main-run sample totals about 472 seconds of isolated file work.
Six shards predict about 79 seconds each, leaving roughly 40 seconds for setup
and the aggregate within the two-minute target. Five predict about 95 seconds
before setup and leave too little headroom. These are estimates, not CI proof;
the coordinator measures actual verdict time and reduces shards as slow tests
are removed (#1458).

`Lint and typecheck` owns lint, strict typecheck, migration-version validation
and the native artifact/process contracts, which portable unit fixtures do not
prove. Unit shards prepare the portable runtime. No real PostgreSQL service,
provider image, binary publication or browser measurement runs in this workflow.
Database-dependent cases remain available for explicit integration runs; they
are not CI unit evidence. The aggregate depends only on static checks and units
and rejects failures, skips and cancellations. See the CI policy in AGENTS.md.
