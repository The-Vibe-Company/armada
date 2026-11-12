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

Claude uses final SDK result modelUsage snapshots. Codex runtime converts native
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
Native restarts caused by steer retain the original Armada-prompt baseline and
include pre-steer tokens. Missing counters remain null; reported zero remains
zero. Input and cached tokens preserve native counter semantics: Claude input
excludes cache reads, while Codex cached input is a subset of input. Counters
are not added together by the server. Cache-write tokens and provider pricing
are intentionally omitted. Historical streams without reported usage have no
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
