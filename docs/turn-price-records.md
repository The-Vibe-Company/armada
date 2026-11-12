# Server turn-price records (#1163)

This slice implements the **ordinary sandbox usage writer** pricing/storage
contract. `usage.turns[].pricing` is a service-owned, versioned record or null.
No context means unpriced, never zero. Old records not recollected may omit it.
API/MCP status/list and CLI JSON preserve it; the dashboard/native token totals
are not changed to consume amounts in this slice.

A private `recordUsage` option accepts contexts derived from **pre-work admitted
snapshots** plus freshly observed native rows. Context selection for an actual
reported model can happen at finalization, but its rates, capture time, basis
and credential binding must come from admission, never today's catalog or viewer
credentials. No public tool accepts these options. Native `pricing` properties
are stripped, and native decoders continue whitelisting only token fields.

The first valid non-null context for a prompt/model share is frozen, including
an explicit no-price snapshot. Later supplied catalog/connection revisions cannot
replace it or reprice history. Same-input known amounts remain unchanged. Fresh,
coherent updated native inputs can complete/recalculate using the **same frozen
snapshot**. Unknown price remains unknown if an updated catalog later gains it.

```json
{
  "schemaVersion": 1,
  "basis": "api_equivalent",
  "credentialId": "<admitted-account-id>",
  "credentialVersion": 1,
  "capturedAt": "2026-11-12T12:00:00.000Z",
  "snapshot": "<frozen PriceSnapshot or null>",
  "usd": "0.00022",
  "unknown": null,
  "inputs": "<observed pricing input tuple or null>"
}
```

`usd` is an exact decimal USD string computed by the existing server calculator,
not a floating-point/native SDK cost figure. It is not money paid. Subscriptions
use API-equivalent basis. Known quotes require identified credential provenance,
matching model/harness, supported frozen rates and required native counts.
Counter/TTL/price uncertainty stays null with the calculator's closed reason.
Snapshot/context validation rejects coercible enums, malformed rates and extra
fields; it never copies arbitrary credentials into a quote. `inputs` is evidence
for pricing, not another set of tokens to add into native totals.

Native SQL observations still merge monotonically, but a max-per-field union can
produce a tuple no harness reported. Such a tuple must not be priced. A matching
fresh observation or previously stored witness is required. Retained rows alone
are not fresh observations, including when history/files become unavailable.
Missing or unsupported cache-write TTL is not inferred; the calculator retains
its source-specific rules. Quote records store only counters/rate provenance, not
transcripts, endpoints or model keys.

Native merge and quote publication share a row-locked transaction; publication
failure rolls both back. Existing interior visibility applies to quotes. Managed
parents keep their separate journal writer. Query-only SQL embeddings can still
record unpriced telemetry; once a session has a frozen pricing context they must
provide transaction support, otherwise the whole usage update is refused rather
than erase provenance or leave stale amounts next to changed counters.

## Integration boundary and coordinator staging check

The ordinary collector now passes fresh observations but **does not yet load and
supply admission contexts**. Thus standard newly collected shares have
`pricing: null` until the next integration reads #1205's admitted book and selects
actual-model snapshots (and configured overrides). No context is manufactured for
legacy sessions. This is a storage/calculation prerequisite, not full session-cost
or cross-UI acceptance; no automatic backfill/current-price lookup is performed.

After normal server rollout, on a Modal golden:

```sh
armada launch <modal-golden> --provider modal --agent claude "Reply OK"
armada wait <id>
armada status <id> --json
armada list --json
```

Expect native counters retained and newly collected shares explicitly unpriced
without an admission-context producer; repeated reads must not invent amounts.
Metadata-only org viewers still get null usage. No migration/runtime update is
needed. Known-quote computation, changed-input replay, frozen null prices, native
spoof rejection, scalar-merge coherence, failure atomicity and MCP output-schema
round trips are exercised offline with real PGlite migrations and SDK clients:

```sh
bun test packages/mcp-server/test/turn-pricing.test.ts
```

Hand arithmetic protected there: Claude input 10/output 20, no cache writes or
reads, frozen $2/$10 per million => **$0.00022**; later input 30/output 40 =>
**$0.00046**, even when a new catalog offers a different input rate. Coordinator
real-session math and API/CLI/dashboard parity remain the later producer/consumer
integration check; workers hold no staging/production credentials.
