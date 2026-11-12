# Server session amounts (Modal)

This integration stacks on #1240's frozen turn-quote storage and uses #1205's
immutable pre-work admission book. Ordinary usage recording now selects the
**exact native model ID** from that book inside the same authorized row-locked
transaction as counter merging and quote publication. No current catalog,
viewer credential, provider monetary figure or requested-model fallback is used.
Fresh native observations remain required; replayed retained/synthetic tuples
cannot become new pricing evidence.

## Returned fields

`POST /api/v1/sandbox/status`, MCP `status`, API/MCP list, and
`armada status <id> --json` return:

- `usage.turns[].pricing.usd`: persisted exact decimal USD string or null.
- `usage.turns[].pricing.snapshot`: the frozen applied rates and source revision.
- `usage.cost`: server aggregate over those persisted quotes, for example
  `{"currency":"USD","usd":"0.00022","basis":"api_equivalent","unknown":null,"unpricedTurns":0}`.

The aggregate uses integer decimal arithmetic, not floating point. Its amount is
**null if any turn/model share or prompt coverage is unknown**; it never presents
a priced subtotal as the full session amount. `basis` comes from the persisted
quotes, not the reader's account. A mixed/unverified basis is null.
`unpricedTurns` counts unknown prompts plus missing covered prompts, or is null
when coverage itself cannot be counted. Known empty sessions can total `"0"`;
missing figures are never converted to zero.

Unknown reasons: `admission` (no valid pre-work source), `price` (no exact rate),
`tokens` (missing/incoherent counters), `pricing_dimensions` (an explicitly
unsupported cache-write lifetime), and `coverage` (not all admitted prompts are
represented). Metadata-only readers still get `usage:null`.

Per-share dollars are stored; the session sum is projected from those stored
quotes, without repricing. Existing status/list reads are sufficient to collect
retained Modal history; closed reads require no live provider or credentials.
Old sessions without an admission book remain unknown: **no backfill from today's
prices**. A previously unknown rate cannot be replaced by editing a connection or
refreshing the catalog. Tokens remain visible independently of pricing coverage.

## Coordinator staging replay

After normal server rollout (the #1205 admission migration must already be in
place), launch **new** Modal sessions, one Claude and one Codex:

```sh
armada launch <modal-golden> --provider modal --agent claude "Reply OK"
armada wait <id> --json
armada status <id> --json | jq '{cost:.usage.cost, turns:.usage.turns}'
armada list --json
```

Repeat with `--agent codex`. Read the same IDs with MCP `status` and
`POST /api/v1/sandbox/status`; the decimal strings must match CLI JSON exactly.
Use the returned snapshot rates (USD per million) and native buckets to compute
by hand: Codex uncached input is `input-cached-cacheWrite`; Claude input is already
uncached. Cache reads/writes are separate priced buckets; reasoning is part of
output unless the snapshot explicitly has a separate reasoning rate. Do not add
native totals as though their buckets were disjoint.

Offline arithmetic protected at the real admission/collector/SQL/HTTP/CLI boundary:
Claude 10 input + 20 output, no cache buckets, frozen $2/$10 per million gives
`"0.00022"`; adding a 30/40 turn gives `"0.00068"`. The production-shaped OpenAI
fixture now pins `gpt-6.1-sol`: input 13137, output 6, reads 0, writes 13134,
reasoning 0, default cache TTL, at $2/$10/$0.1/$2.5 gives `"0.032901"`.
See [default token rates](default-token-rates.md) for source verification and
precise default-policy semantics. These are synthetic native-provider fixtures,
**not a claim of real-provider acceptance**.

Missing prices/counters or explicit non-default cache lifetimes without applicable
rates remain unknown. Omitted TTL uses the provider’s default rate, and catalogue
complexity does not veto otherwise rated token classes. Legacy sessions without
pre-work snapshots must not be assigned today's rates.
Stop and re-read a priced session: amount/source must remain stable. A member
without interior access must receive null usage. Unknown models and custom
endpoints without admitted prices must show null USD while retaining tokens.

## Boundaries still to deliver

This PR does not wire #1223's configured connection prices into admission; new
custom-endpoint books still contain no public-rate fallback. That integration
must precede the custom-price staging acceptance. Dashboard/iOS/human CLI cost
views still need switching off their legacy client calculator onto server values;
JSON API/CLI/MCP parity here is not a claim those UI views are done. Managed-parent
journal pricing, cross-session totals, and unverified native pricing dimensions
remain separate work. No schema change, automatic reprice, runtime update,
deployment or remote migration is performed by this worker.
