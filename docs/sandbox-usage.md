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
A resumed native thread without an observed baseline reports null counters for
its first observed turn; later baselines are known within that runtime process.
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
subsets exceed aggregate writes produce an unknown breakdown. Old native CLI results without
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
