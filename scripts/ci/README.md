# Unit shards and PostgreSQL coverage

`bun scripts/ci/unit-shards.ts --check` discovers Git-tracked Bun test filenames
(`.test`, `_test`, `.spec`, `_spec` with JS/JSX/TS/TSX extensions), constructs eleven
nonempty shards, and rejects missing, repeated or foreign assignments. Stage new
tests before checking locally; Actions checks out all committed files. Discovery
excludes separately invoked `.integration.ts` and dashboard `.e2e.ts` specs.

`bun scripts/ci/unit-shards.ts 1` (through `11`) runs each exact `./file` in its
own Bun process, serially, with `--no-orphans`. New files automatically join the
plan with a one-second estimate. `test-durations.json` supplies measured weights;
obsolete entries never affect coverage. Longest-first greedy placement with path
tie-breaking is deterministic across runners.

Static checks own native build/validation and native-only conformance cases.
Unit shards prepare the portable runtime but do not start PostgreSQL or apply
migrations. **Golden PostgreSQL concurrency** owns the disposable PostgreSQL 17
service and runs every tracked `*.test.ts` referencing
`ARMADA_TEST_POSTGRES_URL`, each in an isolated Bun process. This includes mixed
files whose PostgreSQL-only cases skip in unit shards; their ordinary cases run
in both jobs. New PostgreSQL cases must use that environment variable, as the
current tests do, so they join the real-database job automatically. No test is
deleted or excluded from unit discovery.

The always-run **Lint, typecheck and test** aggregate still requires successful
static checks, the entire unit matrix, PostgreSQL concurrency, migration versions,
golden OS gate and binaries. Failure, cancellation and skipping cannot produce a
green aggregate. PR and merge-group triggers and required names are unchanged.

## Timing baseline and follow-up (#1423)

GitHub Actions API snapshots on 2026-11-13 (seconds, rounded to API precision):

| PR run | Required verdict | Unit container initialization | Unit migrations | Unit install | Unit work | Static job |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 43412944103 | 102 | 11–16 | 4–18 | 6–10 | 29–50 | 61 |
| 43415620871 | 187 | 12–77 | 5–15 | 6–36 | 26–48 | 57 |

Initial jobs started within 3–6 seconds. Bun setup was generally 0–3 seconds.
Static typecheck itself took 18–21 seconds; native checkpoint work 9–10 seconds.
The PostgreSQL job took 41–48 seconds before consolidation. Binary jobs took
32–47 seconds after the migration gate (12–13 seconds). The dominant avoidable
cost was eleven copies of container initialization and migration application,
not shard work or typecheck. Consolidating it removes that setup from every unit
shard; the enlarged PostgreSQL job must be measured, not assumed faster.

Acceptance remains **ten consecutive PR runs after the final optimization PR
with required verdict <110 seconds**. Record run IDs and verdicts on #1423;
do not substitute local timings, estimates, or the non-required 120-second budget
check for that evidence. No staging access is needed: the coordinator's single
check is the next PR's required-verdict timing and complete PostgreSQL test log.

The MCP server's common fixtures clone an immutable migrated PGlite snapshot per
database (`scripts/test-support/migrated-database.ts`). Connections, schemas,
roles and rows remain independent. Fresh migration tests still call
`openDatabase` + `applyMigrations` directly.
