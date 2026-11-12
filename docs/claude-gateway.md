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

## Dashboard replacement

On Models, use the saved Anthropic account menu → Replace key. Connection
type is initially unselected because sealed gateway details are never returned.
Choose Custom gateway (Modal) and re-enter its URL, bearer/API-key auth and
new key. Choose Anthropic default endpoint only when deliberately using the
vendor-default API. JSON is not accepted as the key in either mode. Switching
destination or auth clears the password; refused writes keep the selected
mode/auth while clearing the key. No secret or endpoint is prefilled.

Coordinator staging addition: rotate an existing gateway account using each
supported auth mode and owner-held credentials. Expect unchanged account
ID/name/default, increased revision, and a new Modal launch returning MODEL_OK
on initial and subsequent turns. Old version-bound sandboxes and stale browser
tabs must refuse, not overwrite the new revision. Subscription and Codex
replacement remain unchanged. No migration/new setting; dashboard rollout only.

## Runtime delivery

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
