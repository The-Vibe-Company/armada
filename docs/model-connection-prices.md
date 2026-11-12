# Prices on custom model connections

Codex and Claude custom connections accept exact per-model prices through
`armada creds set`. Rates are decimal **USD per million tokens**, not a total
bill. Use the exact model ID the harness reports (for Azure, the deployment ID):

```sh
armada creds set openai --name foundry --base-url 'https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1/responses' \
  --price-model DEPLOYMENT --price-input 2.5 --price-cached-input 0.25 --price-output 15 \
  --file /path/to/private-key
```

For a Claude gateway, replace `openai` with `anthropic` and use its base URL and
Claude model ID. The endpoint/auth options work as before. Keys still come only
from stdin or a private file, never arguments.

`--price-model`, `--price-input` and `--price-output` must appear together.
`--price-cached-input` is optional. Zero is an explicit zero rate; an omitted
cache rate is unknown, not zero. Rates allow up to 12 integer and 12 fractional
digits; negative values, exponent notation and non-finite values are refused.
These flags require `--base-url` and a named account create/replace operation.

Replacement (`--id ID --expected-version N`) replaces the whole connection,
including prices: re-enter all endpoint options and rates to retain them.
Existing version-bound sessions/templates do not silently adopt a changed rate.
For multiple models or cache-write/reasoning rates, use the existing private
connection JSON input instead of endpoint flags. Its `prices` object maps exact
model IDs to decimal-string `input`, `output` and optional `cacheRead`,
`cacheWrite`, `reasoning` fields.

Prices stay in the sealed account envelope; credential listings do not return
it. The server's #1163 pricing pipeline freezes overrides for new sessions and
prices harness-reported tokens. A custom connection with no matching model
price remains unknown; no public-vendor fallback is inferred.

## Coordinator staging check

Using the owner-held Foundry key file, run the command above with its real
deployment ID and chosen rates. Launch a new Modal sandbox with the listed
account ID and exact model, requesting `Reply exactly MODEL_OK`. Inspect the
server usage receipt after a completed turn: its price snapshot should identify
the connection override and supplied rates. Compare each priced token class
times its USD-per-million rate. Repeat with a Claude gateway. Repeat without
price flags on a new custom account: expect tokens but unknown cost. Rotate
rates via `--id`/`--expected-version`, launch a new session, and confirm only the
new session uses the new snapshot. Inspect CLI output/listings for no key.

No migration or new environment setting. This CLI-only slice needs the existing
server connection-price support (already on main). No staging credentials are held by workers.

## Dashboard

On Models, create an API-key account with a custom endpoint, or choose Replace
key and explicitly select the custom destination. Check **Set model prices
(optional)**, enter the **Priced model ID**, **Input** and **Output** rates, and
optionally **Cached input**. These rates use USD per million tokens and the exact
model/deployment ID, not its display name. A blank cached rate remains unknown;
zero is an explicit zero rate. Unchecking the option removes its unsaved rates.

Existing sealed prices cannot be read back. When replacing a connection,
re-enter all rates to retain them; saving without price fields removes the old
rates for newly admitted sessions. Previously frozen session snapshots do not
change. No key, endpoint envelope or price JSON is copied into client state.

Coordinator staging check: repeat the creation and replacement checks above
using these dashboard controls for Foundry and a Claude gateway. Compare the new
session's server price snapshot with the entered rates; repeat without cached
input and then without any prices to confirm unknown is not displayed as zero.
