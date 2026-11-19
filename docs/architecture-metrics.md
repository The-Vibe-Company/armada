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
| `runtimeCommandToFirstVisibleText` | unavailable | The baseline schema has no `created_at` on either runtime table. The epic's ~2 s is an estimate of polling overhead. |
| `launchStageTotals` | unmeasured | See the [2026-11-19 Modal staging baseline](#staging-baseline) for the later launch timing sample. |

Token and path definitions live in `scripts/metrics/architecture-rules.ts` for use by the ratchets. These textual counts measure trends. Indirection, code generation and historical SQL can affect them.

## Coordinator delivery counters

```sh
bun scripts/metrics/delivery-counters.ts --offline
# With ARMADA_METRICS_READ_ONLY_DATABASE_URL already set in the environment:
bun scripts/metrics/delivery-counters.ts --read-only
```

Both modes include the static counters and a trailing seven-day fix share. The Git calculation follows the checked-out branch's first-parent history. It counts merge commits and GitHub squash subjects ending in `(#number)`. Fix subjects start with `fix(`. Pass `--week-ending=YYYY-MM-DD` to end the window at the end of that UTC date.

Use a coordinator-authorized staging PostgreSQL role scoped to read-only access to the metric columns. The role must be able to read all rows used by the aggregates despite row-level security. The transaction sets `row_security = off` so PostgreSQL rejects queries that would otherwise silently filter rows. Column grants alone are insufficient on tables protected by row-level security. The script accepts the URL through the environment and opens an explicit read-only transaction. It prints aggregates and suppresses driver diagnostics that could contain connection details. The launch query reports sample counts and total cumulative milliseconds since acceptance by provider and stage for initial launches with a recorded acceptance. Missing stages contribute no samples.

The runtime report measures elapsed milliseconds from command insertion to the first archived nonblank model text for the accepted prompt, matched by sandbox, epoch and prompt UUID. It reports sample count, p50 and p95. Commands without a successful prompt receipt, without matching archived text, or without a usable timestamp pair contribute no sample. Historical rows and rows written during deployment overlap may lack the required metadata.

Grant the read-only role access to `sandbox_id`, `epoch` and `created_at` on both runtime journal tables, plus `runtime_commands.accepted_prompt_id` and `runtime_events.visible_text_prompt_id`. The encrypted payloads are unnecessary. The metric is unavailable if the role cannot see the required journal columns. Before attributed samples are recorded, the metric reports zero samples and null percentiles.

This measures database archive latency. Observing when the client receives the text is still required to measure polling overhead.

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

On 2026-11-19 (UTC), the coordinator measured 10 fresh, successful, sequential
Modal golden launches through REST on staging. All 10 used the native path,
the Codex harness, the `smoke-modal` snapshot, the prompt `reply OK`, and no
connections. The deployed SHAs were `b6fda81b` (launch 1), `1d10bfa0`
(launches 2–3), `4359b107` (launch 4), and `840718ce` (launches 5–10).

| Timing boundary (nearest rank, n = 10) | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| Shared launcher through harness readiness (`modal_launch_timing.totalMs`) | 13,613 | 20,214 |
| Outer handler stage sum (`modal_golden_launch_timing.stages[].ms`) | 15,728 | 22,160 |
| Client request-to-ready (through receipt of the full launch response) | 15,812 | 22,318 |

The outer stage sum was within 0.3–1.8% of the client wall time on every launch.
The largest stages were `workspace_preparation` (median 6.1 s, up to 13.1 s,
including native setup) and `provider_allocation` (median 5.3 s, including
native runner startup and health). Every launch made 121 SQL adapter query
attempts. This baseline informs #2768. The program targets 8 s p50 and 12 s p95.

Source: [Coordinator staging measurement on #2767](https://github.com/The-Vibe-Company/armada/issues/2767#issuecomment-7003426082).

### Golden launch admission and SQL

Join `modal_golden_launch_timing` to `modal_launch_timing` by `sandboxId` for
fresh successful REST and MCP golden launches. The outer sample covers the
launch handler through response preparation, including receipt publication when
used. Its consecutive intervals end after admission lookups, account resolution,
provider resolution, receipt admission, the shared launcher, and response
publication. The existing readiness and enrolled startup intervals overlap the
outer `shared_launcher` interval. Sum the outer intervals when comparing to
wall time. Use the finer intervals to explain parts of `shared_launcher`, which
also includes work after harness readiness.

The outer sample reports the number of server SQL adapter query attempts for
the whole launch and each interval. This includes a query attempt that fails
while obtaining a pooled connection. It excludes driver-managed transaction
control and database calls from separate requests, such as runtime enrolment.
Receipt replays and failed launches produce no outer sample.

The same event uses `template_rest` for both REST template launch routes and
`routine` for template launches initiated by the routine worker. For these
samples, `admission` includes template and account resolution and the request
claim. `provider_resolution` ends when the template's provider resolver returns.
`template_execution` includes the shared launcher and durable template receipt
publication. Sum those three intervals for template launch wall time within that
boundary. Join with the shared launcher sample for finer attribution.

Template samples start at the template service call, after the routine worker
has checked membership. Routine scheduling and run publication take place outside
this sample. Child launch admission and SQL, REST routing and authentication,
and transport serialization are still outside the measured boundaries.

### Enrolled runtime timing

For a fresh enrolled Modal launch, join `modal_launch_timing` by `sandboxId`
to the successful `armada.runtime.startup_timing` sample for epoch `1`.
Select `armada.runtime.stage` records from that same epoch. The monotonic startup
intervals cover ticket issuance, host bootstrap, the remaining enrolment wait
after bootstrap returns, and health including the final owner/epoch fence. A
runtime that enrols during host bootstrap can have little or no remaining
enrolment wait. These intervals break down part of `runtime_startup`. The
artifact preparation estimate overlaps host bootstrap. Keep both measurements
out of the outer launch stage sum.

Subtract the first `bootstrap_started` observation from the first
`artifact_verified` observation in the same epoch to estimate the bootstrap
cache check, any download, and artifact verification together. Use
`observedAtMs` from the authenticated, committed progress logs. Progress can be
missing, and the difference includes reporting latency. A negative difference
must be treated as unavailable because the observations use server wall clocks.

The `first_event` observation records the first committed archive batch for
the sandbox across all epochs. For epoch `1`, subtract the persisted
`accepted` timestamp for activation `1` from the log's `observedAtMs`.
This estimate depends on clock alignment between the database and server.
Mark missing or negative intervals unavailable. The estimate includes any time
waiting for a prompt and is separate from accepted-to-ready launch time.
