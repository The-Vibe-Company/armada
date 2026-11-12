# Connection price configuration (#1163)

Custom OpenAI endpoint and Claude gateway credential JSON may include `prices`,
keyed by **exact** native model ID. This is a configuration sub-slice: it validates
and seals the prices with the account, then resolves them as server-only
`modelPrices` metadata under that same credential ID/version. It does not yet
apply them to session amounts or change existing cost displays. Admission/final
pricing integration remains separate; accepting a config is not cost acceptance.

Example private-file shape (placeholder key, never a real secret in this repo):

```json
{
  "endpoint": {"version": 1, "baseUrl": "https://example.invalid/v1"},
  "apiKey": "REPLACE_IN_YOUR_PRIVATE_FILE",
  "prices": {
    "exact-native-model-id": {
      "input": "2",
      "output": "10",
      "cacheRead": "0.1",
      "cacheWrite": null,
      "reasoning": null
    }
  }
}
```

For Claude use kind `anthropic` and add endpoint `auth: "api-key"` or `"bearer"`.
Use an owner-controlled HTTPS endpoint exactly as in the existing connection flow.
Prices are flat **USD per million tokens**, nonnegative decimal **strings** with
at most 12 fractional digits and 12 integer digits. `input` and `output` are
required. Cache rates may be absent/null and remain unknown, never silently zero.
Explicit `"0"` is a configured zero rate. An absent/null `reasoning` rate means
there is no distinct reasoning charge: output already includes those tokens. A
configured distinct reasoning rate requires a measured reasoning count; consumers
must split it from output rather than charge both rates for the same tokens.
A configured flat `cacheWrite` rate applies across lifetimes, so the calculator
does not require TTL for that connection rate. Public vendor rates use the provider default when TTL is absent; an explicit
unsupported lifetime remains unknown. Native cache-write **counts** must always
be known (never invented). See [default token rates](default-token-rates.md).

Up to 64 exact model IDs, no whitespace/control characters, no aliases or suffix
stripping. Unknown fields/tier schedules/currencies, numeric/exponential rates,
malformed objects and prototype keys are refused without echoing credential
values. Do not encode a tiered schedule as one flat rate. Missing models have no
configured rate. Empty `prices: {}` means no overrides, not a free model.

No new encryption scheme or secret store: the whole payload uses the existing
sealed credential value. Prices are not provided as native endpoint configuration, environment variables
or arguments, and no price configuration file is installed. Redaction still
protects the complete credential envelope, API key and endpoint; that whole
envelope may travel the existing private redaction channel. Standalone numeric
price strings are not added as redaction secrets or misclassified as API keys.
Existing payloads without prices remain unchanged. Prices are not exposed by
credential list/read APIs in this slice. Replacing this sealed configuration
uses the account's existing revision/CAS/fencing rules; it is not a live price
edit of an admitted session or a historical reprice.

## Coordinator staging check

Use a private file (mode 0600) containing the owner's working endpoint, key and
prices for the model that endpoint actually reports. Never print or commit it.
Pass the **whole JSON file**, without `--base-url`/endpoint-construction flags:

```sh
armada creds set openai --file /private/priced-connection.json
armada creds list --json
armada launch <modal-golden> --provider modal --agent codex --credential-id <id> "Reply OK"
armada wait <sandbox-id>
```

Repeat with `armada creds set anthropic --file /private/priced-gateway.json` and
`--agent claude`. Expect accepted config, unchanged native endpoint behavior and
no key/rate payload returned in account metadata. Existing no-price connections
must still launch. A malformed rate such as `"-1"` in a separate private test file
must be refused with a sanitized price-validation error before replacement.

Offline tests verify sealing/resolution, explicit zero and unknown buckets,
rejection and no native-environment/redaction leakage for both protocols. The
worker uses no real endpoint/staging credentials. No migration is needed. The
coordinator's actual amount/override-wins comparison belongs to the subsequent
frozen admission/finalization integration; no such claim is made here.
