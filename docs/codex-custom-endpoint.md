# Codex custom endpoints (Modal)

This first #1162 implementation slice reuses a named OpenAI account. Its sealed
value can be either the existing plain API key or the JSON object below. Account
IDs, versions, ownership, defaults, revocation, launch and template selectors
remain unchanged. Listing accounts never returns this object or its key.

```json
{
  "endpoint": {
    "version": 1,
    "baseUrl": "https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1"
  },
  "apiKey": "<supply privately>"
}
```

Use `armada creds set openai --name foundry --file <private-file>` (or stdin)
to create the account. Do not put the key in arguments. Delete the private input
file afterwards. Find the account ID with `armada creds list --json`, then pick it with the existing launch
`--credential-id` option and supply your Azure deployment name as `--model`.
The dedicated connection form and endpoint-test action are subsequent slices;
the existing dashboard OpenAI account value field also accepts this JSON.

Both the base above and a pasted URL ending in `/responses` are accepted.
Normalization preserves the project path. No `api-version` is required for this
v1 Foundry route. Other Responses-compatible services can optionally specify
`endpoint.apiVersion`; this becomes Codex's `api-version` query parameter.
Only HTTPS URLs without userinfo, query strings or fragments are accepted.
Codex only supports the Responses API, not chat-completions-only endpoints.

The runtime writes private `CODEX_HOME/config.toml` with a named provider,
`wire_api = "responses"`, and `env_key = "OPENAI_API_KEY"`. The secret stays
in the selected harness environment, not TOML, argv or logs. This versioned
endpoint object can also be delivered by future enrolment without changing
its shape. Today's Modal bootstrap carries it through the existing private
environment envelope. Runtime-owned config is removed when absent on restart.
Boat native launches refuse custom connections before provisioning a machine.

Configuration fields verified against the
[official Codex configuration reference](https://developers.openai.com/codex/config-reference/).
Actual endpoint compatibility remains a staging check, not a unit-test claim.

## Coordinator staging check (real key stays with coordinator)

1. On staging create the named account using the private JSON input above,
   choose a Modal golden, and launch Codex using its account ID and the
   owner-provided Azure deployment/model. Ask “Reply exactly MODEL_OK”.
   Expect MODEL_OK; listing accounts must contain neither key nor JSON value.
2. Send a second prompt, then stop/resume and send another. Expect MODEL_OK on
   each turn through the same endpoint and bound account. Repeat with the
   pasted URL ending in `/responses`; expect no duplicated suffix.
3. Replace with an invalid key using account revision fencing, then launch a
   **new** Modal sandbox with the updated account. Expect a harness failure,
   never fallback to OpenAI/subscription. The older bound sandbox must refuse
   the changed revision. Revoke the account and expect restore to refuse it.
4. Try the account on Boat: expect “currently require Modal” and no machine.
   Launch existing plain OpenAI and Codex subscription accounts on Modal;
   expect unchanged MODEL_OK.
5. Inspect runtime journal/API errors and process argv: no key. No request to
   the real endpoint was made by the implementation worker.

Deployment prerequisites: rebuild/publish the runtime artifact with the server.
No schema migration or new environment setting is required.

## CLI endpoint fields

Instead of preparing connection JSON, read **only the key** from stdin or a
private file and supply the non-secret endpoint separately:

```sh
armada creds set openai --name foundry --base-url 'https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1/responses' --file /path/to/private-key
```

The optional `--api-version VERSION` is for services that require it; omit it
for the owner-verified Foundry v1 route. To replace an account, use `--id UUID
--expected-version N` in place of `--name`. Personal scope is the default;
`--org NAME` chooses organization scope. `--json` retains the existing
write-only `{ok:true}` output. Keys are never command-line options.

Coordinator staging addition: run the command above with the owner-held key
file, list the ID, launch a Modal golden using that `--credential-id` and
Azure deployment `--model`, and request MODEL_OK. Expect MODEL_OK on initial
and later turns. Repeat with the base URL without `/responses`, omit
api-version in both cases, and expect identical success. Inspect output and
argv: no key. No schema migration or new deployment prerequisite for the CLI.

## Dashboard creation fields

On Models/Harness, open **Add a subscription**, choose **Use an API key
instead**, select **OpenAI API key**, and name the account. Check **Use a custom
endpoint (Modal)**. Paste the Foundry base URL (with or without `/responses`),
leave API version empty for v1, and paste the key in the password field.
Save with **Add API key**; the named account is available in existing launch
and template account selectors. Choose a Modal golden and supply your Azure
model/deployment name at launch.

Coordinator staging check: repeat that creation flow for both pasted URL
forms using the owner-held endpoint/key, then launch each account and request
MODEL_OK on initial and subsequent turns. Expect success and no duplicated
suffix. Inspect account listings/page text: neither key nor connection JSON
is returned. The separate endpoint-test action and dedicated replacement
fields are not part of this creation-form slice; replacement still accepts
the complete connection JSON through the existing flow.
