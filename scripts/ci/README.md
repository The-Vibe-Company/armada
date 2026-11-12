# Unit shards

`bun scripts/ci/unit-shards.ts --check` discovers Git-tracked Bun test filenames
(`.test`, `_test`, `.spec`, `_spec` with JS/JSX/TS/TSX extensions), constructs twelve
nonempty shards, and rejects missing, repeated or foreign assignments. Stage new
tests before checking locally; Actions checks out all committed files. Discovery
intentionally excludes the separately invoked `.integration.ts` PostgreSQL test
and dashboard `.e2e.ts` specs, just like the former default `bun test` command.

`bun scripts/ci/unit-shards.ts 1` (through `12`) runs exact `./file` arguments in a
single Bun process. Files are serial within each shard; jobs have separate runners
and PostgreSQL services. No concurrency, retries or shared mutable fixture are
introduced. New tests automatically join the plan with a one-second estimate;
obsolete duration entries do not affect discovery or coverage.

`test-durations.json` records files taking at least one second in CI run
43277870274, job 131391017030 (2026-11-12). Values are seconds between Bun's file
group headers, including setup/cleanup. Unlisted files default to one second.
Refresh these weights from completed CI logs if the shards drift; weights are
performance hints only, never an allowlist. Longest-first greedy placement with
path tie-breaking is deterministic across jobs.

CI runs static checks alongside twelve shards. Every shard retains native build. Static checks own native version validation
and both real checkpoint boundary checks once, rather than repeating them per shard. Each owns its disposable
PostgreSQL 17 database and applies all migrations. Shard 1 additionally runs the
explicit PostgreSQL runtime publication integration test. The always-run aggregate
retains the required name **Lint, typecheck and test**, and accepts only successful
static checks and a successful entire matrix; failure, cancellation and skipping
cannot produce a green required verdict. Both PR and merge-group triggers remain.

The MCP server's common harness and control fixture clone an immutable, migrated
PGlite snapshot per database (`scripts/test-support/migrated-database.ts`). The
template is built once per Bun worker from the current checkout's migrations,
closed, and never contains test data. Connections, schemas, roles and rows are
independent; no live DB or mutable filesystem is shared. Fresh migration tests
continue to call `openDatabase` + `applyMigrations` directly.
