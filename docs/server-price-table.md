# Server pricing foundation (#1163)

This independently mergeable foundation exports `resolvePrice` and `priceTurn`
from `@armada/core/server` only. It deliberately does not change collection,
storage or existing UI figures. The next integration slice must freeze snapshots
at admission, persist them with observations, and replace client pricing; importing
this module alone does **not** meet the session-cost acceptance criteria.

## Maintenance and provenance

Run `bun scripts/refresh-model-prices.ts` from the repository root, review the diff,
and run `bun test packages/core/test/server-pricing.test.ts` before committing.
The vendored subset includes exact Anthropic/OpenAI provider-model IDs, decimal
USD/million rates, fetch time, and the SHA-256 of the source `api.json` bytes.
No requests occur at launch or read time. There are no guessed aliases. Missing
rates stay null. Complex pricing (context tiers, alternate fast/priority/flex modes,
audio or other dimensions) is retained as an unsupported flag and returns unknown,
never the base-tier price. Models with any experimental mode remain unknown until
service-tier selection is verified, even when their base cost has no extra fields.
Review unsupported entries when refreshing; do not silently discard new fields.

Sources checked for this slice:
- [models.dev schema](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema.ts)
  and [MIT licence](https://github.com/anomalyco/models.dev/blob/dev/LICENSE),
  reproduced in `packages/core/src/pricing/LICENSE.models.dev`.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  cache writes have distinct TTL rates; this table's cache-write rate is the 5m rate.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing): cached input
  is distinct from input; the published cache-write column here is 30m.

The resolver never uses public pricing for a custom endpoint. A caller-provided
connection override wins, including explicit zero rates; connection ID/revision
are retained without credentials. This is an input contract for #1162, not a new
connection configuration or database schema. Rates/results are detached copies.
The integration caller must persist them and must not resolve prices again on
historical reads. Callers must bind overrides to the exact admitted model.

The calculator keeps native counters intact, subtracts Codex cache subsets, and
charges reasoning only once (or separates it when an explicit reasoning rate is
present). All required counters must be known, nonnegative safe integers; subset
inconsistencies are unknown. Positive cache writes require verified TTL; unsupported
TTLs are unknown. Optional absent rates are usable only for zero-token buckets.
Amounts are exact decimal strings computed with integer arithmetic, not floats.
The caller is responsible for API-equivalent/subscription labelling and for not
presenting a known subset of a session as a complete total.

## Coordinator staging check

No migration, deployment prerequisite or runtime behavior change in this foundation.
On the checked-out PR SHA in the staging build workspace run:

```sh
bun test packages/core/test/server-pricing.test.ts
```

Expected: all seven tests pass, including hand arithmetic:
- Codex override: `(700*2 + 200*0.1 + 100*2.5 + 300*10)/1e6 = 0.00467` USD.
- Claude Sonnet 5.5 public: `(1000*2 + 200*0.1 + 100*2.5 + 300*10)/1e6 = 0.00527` USD.
- Custom endpoint without prices: unknown; with all-zero override: exactly `0`.

These are deterministic calculator checks, **not** real-session acceptance evidence.
After the integration slice, the coordinator must additionally launch one Claude
and one Codex session on Modal, hand-price native buckets using the frozen
snapshot, and compare API, CLI and dashboard. Missing capture fields must remain
unknown. No worker holds staging credentials or runs a deployment.

## Frozen Modal session admission (#1163)

New Modal launches now persist a secret-free context in the service-only
`sandbox_usage_pricing` table, after recording the sandbox and before sending any
prompt. It captures the provider's entire pinned catalog (including unsupported
entries), catalog hash, capture time, credential ID/version, and cost basis.
Capturing all exact model IDs lets finalization select the model actually reported
instead of guessing from the request. Subscription basis is API-equivalent.

The context is frozen **for the session**: later turns use the same catalog, not a
viewer credential or a refreshed table. Admission inserts are first-write-wins;
updates are refused. This is not an invoice and does not claim rates refresh for
every later turn. A custom endpoint currently freezes an empty price set and must
remain unknown until connection-price configuration is available; it never falls
back to public rates. No credential value, endpoint address, or sandbox environment
is included. The context is not sent to the sandbox or exposed by public APIs.

This slice does not yet compute/store turn amounts or switch API/CLI/dashboard
cost consumers. It establishes the durable prerequisite; existing historical
sessions and embeddings without the optional admission port have no context and
must remain unpriced in that future integration. No backfill or repricing occurs.
If persistence fails, launch fails before inference and uses existing cleanup.

### Coordinator staging check

Apply `20261112133000_sandbox_usage_pricing.sql` through the normal migration
process before deploying the server. The worker never applies remote migrations.
Launch on an existing Modal golden:

```sh
armada launch <modal-golden> --provider modal --agent claude "Reply OK"
armada wait <id>
```

Using an authorized service/operator database connection (never a user JWT), run:

```sql
select s.id, p.context->>'catalogRevision' as revision,
       p.context->>'basis' as basis,
       p.context->>'credentialId' as credential_id,
       p.context->>'credentialVersion' as credential_version,
       p.context->>'customEndpoint' as custom_endpoint
from public.sandboxes s
join public.sandbox_usage_pricing p on p.sandbox_id=s.id
where s.id='<id>'::uuid;
```

Expected one row: pinned source hash, launch credential binding, subscription
`api_equivalent` (API key `estimated`), and false for a public endpoint. Send a
second prompt and recheck: the context must not change. Launch Codex with an
existing custom-endpoint credential: expect true and `context->'prices' = '{}'`.
Ordinary authenticated users must not be able to select this table. Do not mutate
a staging row to test immutability: offline PGlite tests exercise update refusal,
replay, admission-before-prompt, and failure-before-inference. Session amount
acceptance remains assigned to the subsequent pricing/store/read slice.
