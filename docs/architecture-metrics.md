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
| `bespokeLeaseClaimImplementations` | 13 | Distinct SQL table names with assignments to lease-expiry columns in updates and upserts, including worker, claim and dispatch expiry, excluding null clears. `leaseClaimTables` lists the names. This includes archived migration source and counts multiple claims on a single table once. |
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

The runtime journal tables record database insertion time for new commands and events. Rows written before the timestamp migration remain undated and contribute no samples. On a schema with both timestamp columns, the latency query measures to the first recorded event in the same sandbox and epoch before the next command. This time-window estimate can include unrelated events. New runtime archive writes record `visible_text_prompt_id` for nonblank model text linked to a prompt UUID. Earlier rows and rows inserted by an older server during deployment have no such metadata. New prompt completions record the UUID of the first successful reply in `runtime_commands.accepted_prompt_id`. Older completions have no attribution. A visible-text report can join these columns by sandbox, epoch and prompt UUID. Isolating polling overhead also requires observing when the client receives the text.

## Modal launch timing (#2767)

The server emits one `modal_launch_timing` JSON record after the shared golden
launcher publishes a successful launch. The measured intervals end at harness
readiness. Use the logical `sandboxId` to join the record with the existing
launch stages and runtime events. The `path` field
distinguishes the enrolled and native runtime paths.

Each `stages[].ms` is a consecutive interval on the server's monotonic clock.
`totalMs` starts when the shared golden launcher accepts the request and ends
after it records harness readiness. This boundary excludes request routing
before the shared launcher, initial prompt dispatch, and final state publication
and cleanup. For idle launches, the first event can occur long after readiness.

| Interval ends at | Work included |
| --- | --- |
| `launch_plan` | Golden lookup, placement and launch defaults, skill and connection validation |
| `credential_resolution` | Main credential resolver |
| `preallocation_admission` | Credential validation, repository authorization, golden fence, account admission and pre-fork checks |
| `provider_allocation` | Provider fork, including native runner installation, startup, and health on the native Modal path |
| `registration_and_binding` | Sandbox row and stage writes, lease handoff and connection binding |
| `machine_readiness` | Provider readiness wait and its stage write |
| `runtime_startup` (enrolled) | Runtime configuration, bootstrap, enrolment and runtime health |
| `workspace_preparation` | Workspace setup and checkout stage write, plus preceding native setup on the native path |
| `finish_initialization` | Remaining skills, connections, and pre-start work |
| `ready_stage_record` | Harness-ready stage write |

### Staging baseline

Modal launch p50 and p95 are pending coordinator measurement. The individual
12.3 s staging and 17.3 s production measurements cited in #2767 do not establish
percentiles. The program targets 8 s p50 and 12 s p95.

For successful staging launches, record the deployed SHA, date, path, sample
count, and workload. Calculate nearest-rank p50 and p95 from `totalMs` and
compare the summed intervals with an independently measured wall time using the
same admission and readiness boundary. Report request-to-ready wall time
separately to show work outside that boundary. Per-launch SQL counts and separate
download/verification, enrolment wait, and first-event measurements are pending.
