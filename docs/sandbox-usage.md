# Sandbox usage (#770)

API/MCP status and list (including CLI `armada status` and `armada list --json`)
include `usage`: `computeSeconds`, `turnCount`, and `turns` with reported
`inputTokens`, `outputTokens`, `cachedTokens` and model. There are no server
prices. Usage is interior data: organization metadata-only list readers receive
null.

Runtime is accumulated atomically from confirmed ready/running transitions to
provider-reported stop timestamps. Provisioning before confirmed readiness is
not counted. Legacy rows, missing provider stop timestamps, and a resume without
a recorded stop make runtime unknown instead of including offline time. An open
interval has no confirmed end, so computeSeconds is null until stopped; this is
not a provider billing meter or a live elapsed estimate. Unknown provider-side
stop times cannot be reconstructed; this is observed operating time, not total
billed compute.

Status/wait reads collect complete event history (up to 10,000 events) and save
idempotent per-turn snapshots. List uses that last saved collection; it does not
start compute or scan every sandbox. Collection failure or a history above the
budget retains the previous observation; unknown turn count remains null.

Claude uses final SDK result modelUsage snapshots. The pinned SDK restores
cumulative per-model totals when resuming a transcript; they are not the new
Armada prompt's counts. The runtime now nulls normalized model token counters
and SDK cost estimates for resumed queries without a verified pre-prompt baseline
(`usageAccounting.reason: resumed_baseline_unverified`). Fresh queries retain
reported counters. A native session-ID change during a prompt also invalidates
whole-prompt attribution (`session_reset`), including across steer. No cumulative
snapshot is treated as a delta or replaced with main-loop-only `usage`, which
excludes subagents. Native model IDs/metadata remain available. This conservative
slice now recovers the last valid native cost-state before creating the query,
then subtracts all per-model counters and SDK cost. The same persisted state is
what the pinned CLI restores, including subagent/auxiliary pipeline usage.
Missing/ambiguous/unreadable native state or regressing/removed counters stay
unknown. Lookup is bounded to 1,024 project entries and a 32 MiB transcript;
exceeding these limits also means no verified baseline. Optional legacy
thinking/cache-TTL counters start at zero as in the native ledger. No transcript
text leaves the runtime.
Intermediate native result events during steer carry empty `modelUsage`, null
SDK cost estimates, and `usageAccounting.reason: intermediate_result`. Only the
final native result publishes prompt accounting, so a later session reset cannot
leave measured shares for model IDs omitted from the final result. Existing
historical observations are not automatically corrected. Codex runtime converts native
thread cumulative token totals to turn deltas, never sums last-request counters.
Codex emits one normalized usage snapshot at the end of an Armada prompt (also
on failure/interruption when usage was observed), rather than per-update model
shares. Its model is the native thread start/resume response, never the requested
alias or a hard-coded default. When no model is requested, native configuration
selects the model; subsequent native turn starts use the resolved model. Missing
native model metadata stays null. A `model/rerouted` notification for that thread
makes the entire prompt's model unknown: cumulative totals cannot allocate tokens
across models, including native turns restarted by steer. Notifications belonging
to another thread do not invalidate attribution. Intermediate token updates still
maintain the next-prompt baseline, but are not published as separate usage rows.
A resumed native thread without an observed baseline reports null counters for
its first observed turn; later baselines are known within that runtime process.
A verified native snapshot received before turn dispatch can now establish a
resumed baseline; missing, invalid or late snapshots stay unknown. Unclosed
native turns cannot seed later baselines. See [Codex resumed usage](codex-resumed-usage.md)
for the timing/validation contract, known limits and coordinator staging check.
Native restarts caused by steer retain the original Armada-prompt baseline and
include pre-steer tokens. Missing counters remain null; reported zero remains
zero. Input and cached tokens preserve native counter semantics: Claude input
excludes cache reads, while Codex cached input is a subset of input. Counters
are not added together by the server. When Claude ModelUsage reports cache-write lifetime detail, `cacheWriteTokensByTtl`
retains `fiveMinute` and `oneHour` token subsets. They are already included in
`cacheWriteTokens`; do not add them to input or charge them twice. An absent
breakdown means the native CLI did not report it. Within a reported breakdown,
an absent bucket remains null, not zero. Its sum may be below aggregate writes
(older sessions/unclassified writes); do not price the remainder as 5-minute
writes. Invalid counts, an unknown aggregate, or subsets exceeding aggregate
writes make both lifetime buckets unknown. No TTL is inferred from result-wide
usage or allocated between models. Provider pricing remains a separate concern. Historical streams without reported usage have no
invented token counts.

No dashboard UI, quotas, billing, provider API calls, background telemetry
worker, or production migration application is included. Apply the versioned
migration with the normal release process before running this server version.


## Coordinator staging check: Codex model attribution (#1163)

After the normal runtime deployment, launch on an existing Modal golden without
`--model`, then with an explicit model (or configured Codex endpoint model):

```sh
armada launch <modal-golden> --provider modal --agent codex "Reply OK"
armada wait <id>
armada status <id> --json
armada logs <id>
```

Compare the normalized `armada/turnUsage` event in logs with `usage.turns` in
status: expect one final row for the prompt, with the native resolved model
(not an assumed `gpt-6.1-sol`). Send a second prompt, then stop/resume and send
again: the native model should still be used; missing resumed token baselines
remain null (this slice does not reconstruct history). Exercise steer and
interrupt: terminal observed counters are retained without pre-steer duplicate
model rows. If the service reports `model/rerouted`, expect null model for the
whole prompt, preserved counters, and unknown pricing rather than a guessed
single-model amount. Missing native model metadata likewise stays null. Service
rerouting is not forced by these commands; the deterministic JSONL test covers
late reroutes and unrelated-thread notifications offline. No migration or
provider transport change; storage/price integration remains a following slice.

## Coordinator staging check: Claude resumed accounting (#1163)

After normal runtime rollout, run on a Modal golden:

```sh
armada launch <modal-golden> --provider modal --agent claude "Reply OK"
armada wait <id>
armada status <id> --json
armada send <id> "Reply OK again"
armada wait <id>
armada logs <id>
armada status <id> --json
```

Expect fresh and resumed prompts to report their own per-model counters and
estimated cost, not historical cumulative totals. Repeat after stop/resume;
status totals should remain complete and cost should be computed. The native
modelUsage/cost-state baseline must be available. Missing or unsafe baseline
retains explicit unknown with resumed_baseline_unverified; a session-ID change
or reset cannot publish guessed deltas. Intermediate steer results remain
suppressed and the final result covers the complete Armada prompt.

Native evidence (#1329): pinned Claude Code 2.1.322 was run locally against a
loopback Anthropic protocol fixture, once fresh and once after process restart.
The native result changed from 12 input / 3 output to cumulative 24 / 6, while
the saved cost-state was 12 / 3. A separate two-driver probe with this runtime
reported 12 / 3 for both prompts. The accounting-only recording is in
packages/agent-runtime/test/fixtures/claude-resume-recorded.json. Model responses
were simulated; this is native serialization/restoration evidence, not an
authenticated provider or staging run. No production access was used.

There is no migration. Coordinator check: staging Modal Claude/API-key
resume_usage plus exact-turn counters, complete totals and computed cost.

## Coordinator staging check: Claude cache lifetimes (#1163)

After normal server deployment, launch a Claude session on a Modal golden:

```sh
armada launch <modal-golden> --provider modal --agent claude "Reply OK"
armada wait <id>
armada logs <id>
armada status <id> --json
```

Compare each model's result `cacheCreationEphemeral5mInputTokens` and
`cacheCreationEphemeral1hInputTokens` with status `usage.turns[].cacheWriteTokensByTtl`.
Expect `fiveMinute` / `oneHour` to retain native token counts; absent native fields
must not become zeros. Known lifetime subsets must not exceed aggregate
`cacheWriteTokens`. Mixed or incomplete coverage is not a single assumed TTL.
Repeat status and list reads: the stored nested detail remains stable and
metadata-only viewers still receive null usage. Stale writers retain previously
observed lifetime subsets; conflicting non-monotone observations whose merged
subsets exceed aggregate writes produce an unknown breakdown with `conflicted: true`.
This conflict evidence is sticky for that prompt/model: replaying either earlier
observation cannot restore known buckets. There is no automatic conflict recovery
without authoritative ordering/reset evidence; ordinary later status writes do
not provide it. Missing-detail unknowns without a conflict can still be completed
by later valid native observations. Old native CLI results without
TTL detail retain their previous shape. An undercount is preserved as a subset,
not filled with guessed tokens. Native TTL selection cannot be forced by these
commands; offline regressions cover mixed, missing, partial and invalid buckets.

This server-extraction slice uses the already forwarded native result; it needs
no runtime/transport rollout, migration or connection configuration. There is no migration/backfill job; ordinary status collection may recover TTL
detail from retained native result events. It does not correct cumulative-vs-per-turn
Claude result semantics on resumed sessions, integrate pricing, or meet the full
session-cost acceptance yet. Those remain follow-up slices. Field semantics were
checked against pinned Agent SDK 0.3.322 `ModelUsage` types and the
[official SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#modelusage).
