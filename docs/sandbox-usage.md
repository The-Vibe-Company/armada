# Sandbox usage (#770)

API/MCP status and list (including CLI `armada status` and `armada list --json`)
include `usage`: `computeSeconds`, `turnCount`, and `turns` with reported
`inputTokens`, `outputTokens`, `cachedTokens` and model. There are no server prices.
Usage is interior data: organization metadata-only list readers receive null.

Runtime is accumulated atomically from Armada-recorded stop/delete and resume
transitions. New rows start a recorded interval at insertion. Legacy rows have
unknown runtime. An open interval has no confirmed end, so computeSeconds is null
until stopped; this is not a provider billing meter or a live elapsed estimate.
Unknown provider-side stop times cannot be reconstructed.

Status/wait reads collect complete event history (up to 10,000 events) and save
idempotent per-turn snapshots. List uses that last saved collection; it does not
start compute or scan every sandbox. Collection failure or a history above the
budget retains the previous observation; unknown turn count remains null.

Claude uses final SDK result modelUsage snapshots. Codex runtime converts native
thread cumulative token totals to turn deltas, never sums last-request counters.
A resumed native thread without an observed baseline reports null counters for
its first observed turn; later baselines are known within that runtime process.
Missing counters remain null; reported zero remains zero. Input and cached tokens preserve native counter semantics: Claude input excludes
cache reads, while Codex cached input is a subset of input. Counters are not added
together by the server. Cache-write tokens and
provider pricing are intentionally omitted. Historical streams without reported
usage have no invented token counts.

No dashboard UI, quotas, billing, provider API calls, background telemetry worker,
or production migration application is included. Apply the versioned migration
with the normal release process before running this server version.
