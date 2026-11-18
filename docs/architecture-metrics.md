# Architecture program counters

Run the static counters from a checkout with Bun and Git. Commit or stage new files before measuring so Git includes them.

```sh
bun scripts/metrics/architecture-counters.ts
```

The command reads the working copies of Git-tracked regular files, including local edits. Pass a checkout path as the first argument to measure a different tree. To reproduce the 2026-11-18 baseline from a checkout containing the scripts:

```sh
metrics="$PWD/scripts/metrics"
git worktree add --detach /tmp/armada-metrics-baseline 5e30b1383
bun "$metrics/architecture-counters.ts" /tmp/armada-metrics-baseline
(cd /tmp/armada-metrics-baseline && bun "$metrics/delivery-counters.ts" --offline --week-ending=2026-11-18)
git worktree remove /tmp/armada-metrics-baseline
```

| JSON field | 2026-11-18 baseline | Counting rule |
|---|---:|---|
| `nativeReferences` | 98 | Token occurrences in non-test TypeScript, excluding runtime drivers and the metric definitions. The epic's approximate 91 came from an ad-hoc grep. This counter also accepts single-quoted literals and counts repeated matches on a line individually. |
| `nativeReferenceFiles` | 34 | Files containing those tokens. |
| `nonTestSourceLines` | 167,729 | Physical lines, including blanks and comments, in tracked source under `packages`, `apps` and `scripts`. Tests, E2E support, fixtures and generated files are excluded by path. The epic's 138.7k was an ad-hoc source tally. This inventory includes Swift, styles and tooling as well as TypeScript. |
| `providerIdBranchesOutsideAdapters` | 237 | Literal strict-equality comparisons to Boat, Modal and Docker IDs, regardless of the variable name. This wider textual sweep includes configuration and capability checks, which accounts for the gap from the epic's estimated 136–197 branches. |
| `sandboxStatusWriterFiles` | 14 | Files with recognizable SQL or Supabase writes to the status field, including migrations. Counting only assignments and insert columns excludes nearby status filters. Dynamically assembled statements outside the recognized forms require manual audit, so this count can be lower than the epic's 25-file inventory. |
| `bespokeLeaseClaimImplementations` | 12 | Distinct SQL table names with assignments to lease-expiry columns in updates and upserts, including worker and claim expiry, excluding null clears. `leaseClaimTables` lists the names. This includes archived migration source and counts multiple claims on a single table once. |
| `netSourceLines` | 167,729 | Current tree total on the same basis as `nonTestSourceLines`. Subtract the baseline or base-tree total to get the net change. |
| `weeklyFixShare.share` | 34.89% | 419 fixes among 1,201 merges in the seven UTC days ending 2026-11-18. The epic's 38% came from a manual log tally. |
| `runtimeCommandToFirstEvent` | unavailable | The baseline schema has no `created_at` on either runtime table. The epic's ~2 s is an estimate of polling overhead. |
| `launchStageTotals` | unmeasured | Requires staging data. |

Token and path definitions live in `scripts/metrics/architecture-rules.ts` for use by the ratchets. These textual counts measure trends. Indirection, code generation and historical SQL can affect them.

## Coordinator delivery counters

```sh
bun scripts/metrics/delivery-counters.ts --offline
# With ARMADA_METRICS_READ_ONLY_DATABASE_URL already set in the environment:
bun scripts/metrics/delivery-counters.ts --read-only
```

Both modes include the static counters and a trailing seven-day fix share. The Git calculation follows the checked-out branch's first-parent history. It counts merge commits and GitHub squash subjects ending in `(#number)`. Fix subjects start with `fix(`. Pass `--week-ending=YYYY-MM-DD` to end the window at the end of that UTC date.

Use a read-only PostgreSQL role with access to the metric columns on staging. The script accepts the URL through the environment and opens an explicit read-only transaction. It prints aggregates and suppresses driver diagnostics that could contain connection details. The launch query reports sample counts and total cumulative milliseconds since acceptance by provider and stage for initial launches with a recorded acceptance. Missing stages contribute no samples.

When both runtime timestamps are available, the latency query measures to the first recorded event in the same sandbox and epoch before the next command. This time-window proxy can include unrelated events and cannot isolate poll wait from execution. A visible-text latency baseline needs durable command and event timestamps and a way to identify the matching text event. Until then, the script emits a null latency and an explanation.
