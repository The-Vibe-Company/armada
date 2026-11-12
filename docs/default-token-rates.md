# Default token-rate policy (#1163)

Owner decision on #1163, 2026-11-12 19:06Z: price a turn when every **positive
pricing bucket** has a rate. Zero-token classes never need a rate. A missing
cache-write TTL uses the provider default rate. This supersedes the earlier
blanket fail-closed policy for complex catalogue entries and absent native TTL.

## Rules and verified sources

- Rates still come from the exact model's frozen admission/turn snapshot, not
  today's catalogue, a viewer's credentials, a requested-model fallback or a
  native dollar total. No token counters are invented or changed.
- Codex uncached input is input minus cache reads and writes. Cache-write rates
  replace the ordinary input rate for those tokens; they are not a surcharge.
- With a null reasoning rate, output is output-inclusive: reasoning is not an
  extra charge. [OpenAI explicitly documents reasoning as billed output](https://developers.openai.com/api/docs/guides/reasoning).
  An explicit separate reasoning rate splits output into visible/reasoning;
  a missing reasoning count still blocks positive output when this split is needed.
- The frozen public cache-write rate represents the default lifetime:
  [OpenAI GPT-5.6+ uses 30 minutes, 1.25× input](https://developers.openai.com/api/docs/guides/prompt-caching);
  [Anthropic uses five minutes by default](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
  Null TTL selects this default rate; an explicit unsupported/conflicting lifetime
  remains unknown if writes are positive. Zero writes cannot be blocked by TTL.
  Connection-configured rates remain explicitly flat across lifetimes.
- The legacy snapshot `unsupported` flag records catalogue complexity, **not a
  veto on rated token classes**. Alternate modes/context/audio/image/tool prices
  do not imply those charges were used by a plain turn. The returned figure is
  the admitted default/list-rate **token estimate**, not an invoice, service-tier
  attribution or a promise to include unreported non-token charges. Alternative
  tier billing is not inferred from this flag.
- Missing rates are null, including base input/output. Only positive disjoint
  buckets require a rate. Invalid schemas, missing required native counters,
  inconsistent subsets, unknown models and incomplete prompt coverage still
  produce null USD with an explicit reason. Custom endpoints still have no
  public fallback.

Publication and stored-quote validation share the same calculator eligibility;
there is no stricter shadow guard in session aggregation. Previously known
amounts/source stay frozen. A formerly blocked quote can become known during the
next ordinary collection/retry from its existing validated input witness and
frozen rates. No current-rate backfill, automatic closed-ledger scan or migration
is introduced. Closed rows that are never collected again are not rewritten.

## Production-shape regression and coordinator replay

The reported Codex `gpt-6.1-sol` turn has native input **13137**, output **6**,
cache reads **0**, cache writes **13134**, reasoning **0**, and null cache TTL.
Its existing snapshot has rates $2/$10 input/output, $0.1 reads, $2.5 writes per
million, null separate reasoning, and `unsupported:true`.

Uncached input is **3**. Expected USD is exactly:

```text
(3 × 2 + 0 × 0.1 + 13134 × 2.5 + 6 × 10) / 1,000,000 = 0.032901
```

The real admission → collector → SQL → HTTP status → MCP-discovered schema → CLI
JSON regression pins `"0.032901"` without changing those counters, rates, the
complexity flag or the null native TTL. It also retries an old blocked quote
using only its stored witness/source and verifies an exact two-turn sum.

After normal server rollout, the coordinator launches a new plain Modal Codex
session (OpenAI API-key account, `gpt-6.1-sol`), waits and reads:

```sh
armada launch <modal-golden> --provider modal --agent codex --model gpt-6.1-sol "Reply OK"
armada wait <id> --json
armada status <id> --json | jq '{cost:.usage.cost, turns:.usage.turns}'
```

Hand-price its actual counters from the returned frozen rates using the formula
above. Compare `usage.cost.usd` and each `.pricing.usd` with API
`POST /api/v1/sandbox/status` and MCP `status`; decimal strings must match CLI
JSON. The exact reported shape must return `"0.032901"`, `unknown:null`, basis
`"estimated"`. A replayed existing session needs an ordinary collection/retry;
no worker performs production mutation. No new migration, runtime update or
price-table refresh is required. Workers do not deploy or hold staging secrets.
