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

**Native runtime contracts** owns native build/validation and native-only
conformance cases, in parallel with lint/typecheck.
Unit shards prepare the portable runtime but do not start PostgreSQL or apply
migrations. **Golden PostgreSQL concurrency** owns the disposable PostgreSQL 17
service and runs every tracked `*.test.ts` referencing
`ARMADA_TEST_POSTGRES_URL`, each in an isolated Bun process. This includes mixed
files whose PostgreSQL-only cases skip in unit shards; their ordinary cases run
in both jobs. New PostgreSQL cases must use that environment variable, as the
current tests do, so they join the real-database job automatically. No test is
deleted or excluded from unit discovery.

The always-run **Lint, typecheck and test** aggregate still requires successful
static checks, native runtime contracts, the entire unit matrix, PostgreSQL
concurrency, migration versions,
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

## Current shard weights

`test-durations.json` is refreshed from successful main run **43421358505**
(2026-11-13, commit `a786becaefb01cefe4439dfb821deefc5183ec95`), after database
setup was removed from unit shards. All 374 discovered files have an observation.
Values are the runner's `Completed <path> in <seconds>s` measurements: the entire
isolated Bun child process, including startup and cleanup, not just test bodies.

The observed shard work ranged from **25.598 to 50.079 seconds**. Replaying the
same measurements through the unchanged longest-first planner assigns
**42.964 to 42.970 seconds** to each shard, reducing the predicted longest shard
by **7.109 seconds**. This is a replay estimate, not proof of a faster future run;
runner contention and changed tests can move actual times. No tests, execution
isolation, shard count, or coverage rules changed. New files still default to 1s.

That run's unit jobs took 42–71s including install (6–15s). Lint/typecheck took
39s, native contracts 41s, and PostgreSQL concurrency 61s (10s container start,
10s install, 16s migration application, 18s test work). Unit balance is therefore
the next measured critical-path opportunity. The owner collects the ten-run
verdict window after merge; a main-run sample does not count as PR acceptance.
