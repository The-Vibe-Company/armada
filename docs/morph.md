# Morph model accounts

One Morph API-key account is shared by Claude Code and Codex. OpenCode is not
supported by this account kind. No additional third-party tools or skills are needed.

## Add and launch

After Armada login, store the key from a private file or stdin, never argv:

```sh
armada creds connect morph --name shared --file /private/morph-key
armada creds list
```

Alternatively, dashboard **Models → Add a model account → Morph**: name the
account, paste the key and save. Select that same account for either harness.
The model picker offers `morph-kimik31`, `morph-dsv41flash` and
`morph-dsv41flash-1017`. The key is encrypted and is never returned by listing.

Use the ordinary launch flow for the target golden or Docker host, with
`--credential-id ACCOUNT_UUID --model morph-kimik31` and the desired harness.
For example (replace uppercase IDs; `MODAL_SNAPSHOT` is a Modal snapshot):

```sh
armada launch MODAL_SNAPSHOT --agent claude "Reply briefly" --credential-id ACCOUNT_UUID --model morph-kimik31
armada launch MODAL_SNAPSHOT --agent codex "Reply briefly" --credential-id ACCOUNT_UUID --model morph-kimik31
armada launch "Reply briefly" --provider docker --host HOST_UUID --org ORG_UUID --agent claude --credential-id ACCOUNT_UUID --model morph-kimik31
armada launch "Reply briefly" --provider docker --host HOST_UUID --org ORG_UUID --agent codex --credential-id ACCOUNT_UUID --model morph-kimik31
```

Modal, Docker hosts and runtime-backed Boat use the same credential envelopes.
Boat native Claude gateways remain refused: the native path does not translate
runtime endpoint configuration. Use a runtime-backed launch, not a native fallback.

Claude uses `https://api.morphllm.com`, API-key authentication (not an Anthropic
bearer/OAuth token) and provider aliases. Codex uses the Responses wire at
`https://api.morphllm.com/v1`; the internal provider/env names are Armada's,
not secrets in command arguments. Codex may warn about missing model metadata.

## Usage and diagnostics

Status retains the model and tokens actually reported by the harness. Morph
model prices are not inferred from Claude/OpenAI prices: cost is unknown when
no saved price is known, never zero or a fabricated estimate. A flat plan's
subscription payment is not a token-based invoice.

`armada creds test SANDBOX_UUID --model morph-kimik31` checks the bound account
with a tiny billable request. HTTP 401 means the account was rejected: replace
its saved key or check its access. HTTP 429 means rate limited; connection-test
CLI/dashboard diagnostics include a bounded numeric `Retry-After` delay when
provided. No automatic retry is introduced. These checks do not prove streaming
or tool compatibility; live harness errors remain the harness's diagnostics.

## Coordinator staging acceptance

Configure `claude-morph` and `codex-morph` account cases in the existing accounts
parity runner, using the **same** `modelAccountId`, model `morph-kimik31`, an org
and a Modal golden or Docker `hostId`. Run the ordinary post-deploy accounts
probe. Unconfigured Morph cells say **no account configured**, not pass.
Boat is not part of the release gate; on-demand Boat verification is coordinator-only.

For both harnesses on Modal and the owner's Docker host, expect an answer,
the selected Morph model and reported tokens in status. Stop/resume and send
must retain the account binding. Missing live evidence is not a provider pass.
No worker holds a Morph key or claims this live acceptance was run.

Vendor references: [K3.1 configuration](https://www.morphllm.com/kimi-k3-1)
and [API setup](https://www.morphllm.com/kimi-k3-1-api). Current pages describe
Responses support; older provider pages contradict it, so staging must confirm.
