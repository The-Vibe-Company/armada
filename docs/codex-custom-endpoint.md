# Codex custom endpoints

A named OpenAI account can use a custom Responses API endpoint on Modal,
Docker, or runtime-backed Boat. Use an HTTPS base URL without userinfo, a query,
or a fragment. Armada accepts a pasted URL ending in `/responses` and
normalizes it while preserving the upstream project path.

## Create an account from the CLI

Supply the exact upstream model IDs with `--models`. For Azure Foundry, use
the resource's deployment names. Read the API key from stdin or a private file.

```sh
armada creds set openai --name foundry --base-url 'https://RESOURCE.services.ai.azure.com/api/projects/PROJECT/openai/v1/responses' --models my-deployment --file /path/to/private-key
armada creds list --json
```

For services that require an API version, pass `--api-version VERSION`. Leave
it unset for the Foundry v1 route shown above. For organization scope, pass
`--org NAME` to both commands. To replace a connection, use
`--id UUID --expected-version N` in place of `--name` and supply the endpoint
fields and new key again. At launch, use the account ID with `--credential-id`
and its deployment name with `--model`.

## Create or replace an account in the dashboard

Under **What agents have → Models**, open **Add account** and expand **Other
providers and custom endpoints**. Select **Azure AI Foundry** or **Custom
endpoint for Codex** and enter a name. Enter the HTTPS URL, exact deployment
or model IDs, and API key. Leave the API version empty for the Foundry v1
route. Official Azure addresses receive a small billable request per deployment
before saving. If a check fails, the dashboard does not save the account.
Save with **Add account**, then select the account and deployment at launch.

To rotate a key, open the account menu and choose **Replace key**. Select the
provider preset or **Custom endpoint (Modal)** and re-enter the connection
details and key. Select **OpenAI default endpoint** when switching to the vendor
endpoint. The current custom endpoint label includes “Modal” even when you use
the saved account on Docker or runtime-backed Boat.

## Runtime delivery

Codex uses a named provider with `wire_api = "responses"` and
`env_key = "OPENAI_API_KEY"` in its runtime-owned configuration. The key is
delivered through the harness environment. Boat needs the shared-runtime
artifacts to launch with a custom endpoint.
