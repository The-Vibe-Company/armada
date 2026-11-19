# Claude gateways

A named Anthropic account can use a custom Claude gateway on Modal, Docker, or
runtime-backed Boat. The gateway must support the Anthropic Messages API,
streaming, and tool use with Claude models.

## Create an account from the CLI

Pass the base URL separately and read the API key from stdin or a private file.

```sh
armada creds set anthropic --name gateway --base-url 'https://gateway.example.com/anthropic' --endpoint-auth bearer --file /path/to/private-key
armada creds list --json
```

Use `--endpoint-auth api-key` for the `x-api-key` header. Bearer authentication
is the default. Use an HTTPS base URL without userinfo, a query, or a fragment.
Supply the gateway prefix and omit the final `/v1/messages` path.

For organization scope, pass `--org NAME` to both commands. To replace a
connection, use `--id UUID --expected-version N` in place of `--name` and
supply the URL, auth mode, and new key again. Account listings return account
IDs and metadata. Select the account at launch with `--credential-id UUID`
and choose a Claude model served by your gateway with `--model`.

The CLI also accepts the following connection JSON from stdin or a private
file when you omit `--base-url`. Keep the key out of command arguments.

```sh
armada creds set anthropic --name gateway --file /path/to/private-connection.json
```

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

## Create or replace an account in the dashboard

Under **What agents have → Models**, open **Add account** and expand **Other
providers and custom endpoints**. Select **Custom endpoint for Claude Code**
and enter a name. Enter the base URL, select **Bearer (Authorization)** or
**x-api-key** under **Sent as**, and enter the key. Save with **Add account**.

To rotate a gateway key, open the account menu and choose **Replace key**.
Select **Custom gateway** and re-enter the URL, auth method, and key.
Choose **Anthropic default endpoint** when switching to the vendor endpoint.

Replacing a key creates a new account revision. Sandboxes bound to the previous
revision keep their files and conversations, but refuse new messages. Launch
a new sandbox to use the new revision.

## Runtime delivery

The runtime sets `ANTHROPIC_BASE_URL` and selects `ANTHROPIC_AUTH_TOKEN` or
`ANTHROPIC_API_KEY` according to the account's authentication method. Restore
resolves the bound account revision again. Boat needs the shared-runtime
artifacts to launch with a custom gateway.
