# Claude gateways on Modal

A named Anthropic account can hold its existing plain API key, or this sealed
JSON value (the key is never returned by list/get APIs):

```json
{
  "endpoint": {
    "version": 1,
    "baseUrl": "https://gateway.example.com/anthropic",
    "auth": "bearer"
  },
  "apiKey": "<supply privately>"
}
```

Create it with `armada creds set anthropic --name gateway --file <private-file>`
or stdin. Never put a real key in arguments; delete private input afterwards.
Find its ID with `armada creds list --json`. Existing dashboard Anthropic
account paste accepts the same JSON. Dedicated connection fields and a tiny
request test action are separate #1162 slices.

Choose `auth: "bearer"` for Authorization: Bearer, or `auth: "api-key"` for
x-api-key. The URL must use HTTPS without userinfo, query or fragment. Paths
are preserved, including an Anthropic gateway prefix. Supply the base URL,
not the final `/v1/messages` URL. Unlike Codex's Responses paste contract,
Claude gateway URLs are not stripped of API-specific suffixes.

The runtime alone expands the versioned non-secret endpoint object carried in
today's private Modal bootstrap. It selects ANTHROPIC_BASE_URL and exactly one
credential variable (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY), clearing OAuth
and competing auth variables. Credentials never enter TOML, argv or logs.
Restore re-resolves the same account/version through the existing binding.
Existing subscription and plain-key accounts are unchanged. Boat refuses
custom gateway launches before allocation. This payload remains usable by
future enrolment without changing its shape.

Claude Code supports Claude models only; this is not a way to run DeepSeek.
Gateways must support Anthropic Messages, streaming and tool use. No Armada
proxy is hosted. Bedrock/Vertex/Foundry-native switches remain Later, as do
additional header maps. See the [official gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
for the API-key and bearer header mapping and [supported-model limitations](https://code.claude.com/docs/en/llm-gateway).

## CLI gateway fields

Read only the key from stdin or a private file, and give the non-secret URL
and authentication mechanism as separate options:

```sh
armada creds set anthropic --name gateway --base-url 'https://gateway.example.com/anthropic' --endpoint-auth bearer --file /path/to/private-key
```

Use `--endpoint-auth api-key` for an x-api-key gateway. Bearer is the default
when the option is omitted. `--api-version` is Codex-only and is refused for
Claude. Keys are never arguments; delete private input files afterwards.
Personal scope is the default, `--org NAME` selects organization scope, and
`--id UUID --expected-version N` replaces a named account. `--json` keeps the
existing write-only success shape. Claude gateways are Modal-only and support
Claude models, not arbitrary non-Claude models.

Coordinator staging addition: create the account with these fields using the
owner-held endpoint/key, find its ID with `armada creds list --json`, select a
Modal golden and Claude model at launch, and ask for MODEL_OK initially and on
the next turn. Expect MODEL_OK through the selected gateway path/header.
Repeat for each auth mode the gateway supports. Inspect output/argv: no key.
No migration or new setting is required; server/runtime must include #1195.

## Coordinator staging check

1. Privately create the named account above with the owner-provided gateway
   URL/key (worker has neither). Launch a **Modal** golden with `--agent claude`,
   its `--credential-id`, a gateway-served Claude `--model` and the prompt
   “Reply exactly MODEL_OK”. Expect MODEL_OK through the gateway.
2. Send another prompt, stop/resume, and send again. Expect MODEL_OK with the
   same endpoint/account. Repeat with an x-api-key gateway/account using
   `auth: "api-key"`. Inspect gateway logs: correct path and only the chosen
   auth mechanism; inspect runtime/API output and argv: no key.
3. Rotate to an invalid key and launch a **new** sandbox at the new account
   revision: expect failure without fallback. The older bound sandbox must
   refuse the changed revision. Revoke the account and expect restore refusal.
4. Try the gateway account on Boat: expect an early Modal-only refusal with
   no allocation. Existing Claude subscription/plain-key accounts on Modal
   must still answer MODEL_OK.

Prerequisite: publish the rebuilt runtime artifact with the server. No schema
migration or new environment setting. Worker tests make no real endpoint call.
