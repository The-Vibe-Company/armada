# Server-owned session cost (#1163)

Design-only first PR for #1160; later implementation PRs use `Refs #1163`.
No runtime changes, migrations, deployment, or staging credentials in this PR.

## Current state (2026-11-12)

- `packages/core/src/sandbox-usage.ts` extracts per-prompt/model counters;
  `sandboxes.usage_turns` stores observations collected by server status/wait reads.
  See `docs/sandbox-usage.md` for collection budgets and unknown baselines.
- `packages/core/src/model-prices.ts` is a hand-maintained client price table;
  `sandbox-cost.ts` prices counters, including cache writes, in the dashboard via
  `apps/dashboard/src/lib/sandbox-cost.ts`. Prices are not frozen server records.
- `packages/agent-runtime/src/claude.ts` forwards SDK results; `codex.ts` differences
  thread totals, retains steer baselines, but attributes usage to the requested
  model or hard-coded default. Missing resumed-thread baselines remain unknown.
- Cache-write/reasoning fields already exist; capture completeness, not merely
  adding fields, needs work. Boat native collection has unavailable-reason codes;
  do not assume all Boat sessions are measured. #1161 owns runtime parity/removal.

## Target record and capture

Reuse the existing usage collection/store, not a second telemetry pipeline.
One logical session is a sandbox's conversation history across resumes; each
Armada prompt has one or more model/connection shares. Preserve prompt count
separately from model rows. Persist schema version, prompt/native turn identity,
harness, requested model, reported model, resolved pricing model, connection ID
and non-secret connection revision/auth mode, native counters, observation source,
price snapshot, USD decimal amount, basis and explicit unknown reason per share.
Connection identity is frozen from launch/turn admission, never viewer credentials.
No keys, endpoint credentials, transcript or account quota data enter this record.

| Harness | Source and normalization |
| --- | --- |
| Claude | Final result `modelUsage` keyed by reported model: `inputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `outputTokens`, optional `thinkingTokens`. Input excludes reads/writes; thinking is included in output. Retain result `usage` for supported cache-TTL detail and `total_cost_usd` only as diagnostic comparison, not authoritative pricing. Verify whether pinned SDK snapshots span a query or native session before differencing resumed results. |
| Codex | `thread/tokenUsage/updated.tokenUsage.total` input, cached input, output, optional reasoning: end minus verified pre-turn baseline, never sum updates or `last`. Cached is a subset of input; reasoning a subset of output. Resolve model from native start/resume and reroute metadata, not request fallback. Recover a resumed baseline only from verified native history; otherwise keep unknown. Preserve steer baseline; counter resets/negative deltas are unknown. |
| OpenCode | #1164 supplies native per-message usage/model mapping; this lane consumes it later, with no invented counters or proxy metering. |

Native snapshots replace the same share idempotently; repeated status/wait reads
must not double count. Finalize on observed terminal boundaries, including failed
or interrupted turns with measured usage. Incomplete coverage stays incomplete.
Absent counters are null, not zero; a schema-confirmed unsupported/not-applicable
bucket may be zero with provenance. Reject invalid/subset-inconsistent counters.

## Price resolution and arithmetic

1. Connection-specific model prices win (including explicitly configured zero).
   #1162 owns connection storage/configuration; consume its ID, revision, auth mode,
   model mapping and price fields rather than implementing another connection UI.
2. Otherwise use a pinned provider/model entry from vendored `models.dev/api.json`
   for a known public endpoint or subscription. Never match a custom endpoint to
   public pricing just because its model string resembles a public model.
3. Unknown model, custom endpoint without prices, missing required bucket/rate,
   ambiguous model routing or unknown tier => null amount with reason; show tokens.

Vendor only supported price data plus MIT attribution, source revision, fetch date
and content hash. A refresh script validates schema, nonnegative finite rates,
units (USD/million tokens), provider namespaces and reviewed aliases, and emits a
reviewable diff; no network lookup at launch/read time. Missing optional cache or
reasoning prices are not zero. Never strip arbitrary suffixes to guess a model.

Normalize to disjoint pricing buckets: Claude uncached input is native input;
Codex uncached input is input minus cached reads (minus writes only if the native
schema proves writes are a separate input subset). Price cache writes by supported
TTL; unknown TTL with differing rates stays unknown. Output already includes
reasoning: charge output once, or split reasoning from output only when its count
and a distinct rate are known. Never add reasoning to total output a second time.
Amount = sum(bucket tokens × USD/million rate) / 1,000,000, using decimal arithmetic;
round only for presentation. Non-token tool charges/compute are outside this sum.

Freeze rates, source/hash, model mapping, connection revision and basis at admission;
select reported-model shares from that frozen price set at finalization. Save
amounts with observations in the existing collection transaction. Late verified
usage can complete an unknown record using the same snapshot; refreshes/connection
edits never reprice history. Legacy usage without a snapshot stays unpriced, with
no invented historical price. Aggregates are recomputed from frozen amounts.
A partial subtotal is labelled partial with unknown-turn count, never a complete
session total. Subscription basis is **API-equivalent**, not money paid; API-key
basis is estimated. API, MCP, CLI, dashboard and iOS consume one server DTO.

## Small independently mergeable slices and staging evidence

Each PR documents exact supported CLI/API shapes and hand arithmetic for its SHA;
the coordinator alone runs staging checks after normal deployment.

1. **Price/store/read path:** vendor refresh + server calculator + additive storage
   and API DTO; switch dashboard/CLI to it, preserve visibility rules and metadata-
   only redaction. Coordinator: launch one Claude and one Codex prompt via existing
   `armada launch <golden> --agent <claude|codex> "Reply OK"`, then
   `armada wait <id>` and `armada status <id> --json`; compare each bucket × frozen
   rate by hand in the PR, inspect the same sandbox in dashboard and API status.
   Expect identical stored USD/basis (or explicit unknown for capture gaps).
2. **Capture accuracy:** actual model, resumed baseline, cache TTL/write and
   reasoning completeness; no provider rewrite. Coordinator: send a second prompt,
   stop/resume, send again, then steer a turn; inspect status twice. Expect stable
   per-turn totals, no replay doubling, measured first resumed turn or explicit
   baseline-unknown. Repeat slice 1 arithmetic with fully measured Claude/Codex
   sessions to satisfy ticket acceptance. Through #1162's connection flow run a
   custom endpoint with configured prices, then without: override wins / unknown.
3. **Totals:** reuse frozen shares for sandbox/routine/template/day-org totals,
   one API plus dashboard view and `armada usage`; publish exact filters/commands
   in that PR. Coordinator: sum two known sessions by UTC day and compare all
   surfaces; add an unknown session and verify incomplete totals stay labelled.

Design PR staging check: no deploy required; inspect this document against the
current source paths and confirm these slice checks are assigned, not claimed run.
Slices 1–3 add cheapest-boundary offline tests for arithmetic, replay, nulls and
visibility. iOS uses the same DTO; coordinate its consumer rather than fork math.

## Deletions, limits and Later

Delete the client-owned price lookup/calculation and obsolete exports/tests once
consumers use server DTOs; keep display formatting and native counter types.
Update `docs/sandbox-usage.md` when behavior changes. #1161 deletes Boat's native
runner; #1164 owns OpenCode; #1165 owns Docker. Do not build those in this lane.
Known limits: unavailable history cannot be reconstructed; aggregate turn counters
may not identify per-request context tiers, TTL or mixed-model reroute allocation.
These remain explicit unknowns, not silent short-context prices or zero.
Later: invoice reconciliation, non-token tool/compute charges, FX, quotas/billing,
org-wide override policy beyond connection prices, backfill/repricing tools and
additional multi-tenant hardening. Retain existing RLS/access rules now.

## Primary references (checked 2026-11-12)

- [Models.dev MIT licence](https://github.com/anomalyco/models.dev/blob/dev/LICENSE)
  and [cost schema](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema.ts):
  input/output, optional cache/reasoning and tier fields; verify the exact pinned
  JSON units/shape and vendor prices before importing in slice 1.
- [Claude SDK types](https://code.claude.com/docs/en/agent-sdk/typescript#modelusage)
  document model usage and reasoning inclusion; pinned installed SDK fixtures must
  verify TTL detail and resumed-result boundaries before code depends on them.
- [Codex app-server](https://developers.openai.com/codex/app-server/) documents
  token-usage and reroute notifications; verify pinned protocol/history fixtures
  for baseline recovery and cache writes (do not assume a write field exists).
