# MCP service instances and launch defaults

All control requests are authenticated POSTs under `/api/v1/mcp/`, with
`org` selecting an organization the caller belongs to.

- `catalog`: returns `{ services }` with `id`, `label`, `url`, `docsUrl`,
  `availability` (`available` or `setup_required`) and optional `setupMessage`.
- `create`: accepts `name`, `scope` (`personal` or `org`) and `serviceId`.
  The server chooses the canonical HTTP endpoint and OAuth configuration;
  supplied URL/authentication overrides are ignored for catalog services.
  Custom HTTP, SSE and pinned stdio definitions remain supported.
- `metadata`: accepts `id`, optional `name`, optional boolean `defaultForLaunch`.
  This changes no authentication, pending consent, binding or lease.
  Personal owners and organization administrators can change metadata.

Connection DTOs include their independent UUID, nullable `catalogId`,
`defaultForLaunch`, name, scope, transport and authentication status; no secrets.
Multiple accounts for the same service are independent instances.
Catalog identity is immutable after assignment.

Omitting launch `connections` resolves enabled defaults once, before forking.
Organization-visible sandboxes exclude personal defaults. Eligible disconnected
defaults fail with reconnect guidance. An explicit array replaces defaults;
`[]` means none. Actual UUIDs are persisted in bindings, so later default changes
do not alter running or resumed sandbox selections.

CLI examples:

```sh
armada mcp catalog --org UUID
armada mcp add Work --service linear --org UUID
armada mcp rename CONNECTION_UUID "Work account" --org UUID
armada mcp default CONNECTION_UUID on --org UUID
armada launch GOLDEN --agent claude --no-connections
armada launch GOLDEN --agent claude --connections UUID,UUID
```

## Compatibility and deployment

Apply `20261110120100_mcp_catalog_defaults.sql` before deploying the server.
Existing definitions retain null catalog identity and opt-out defaults.

[Notion](https://developers.notion.com/guides/mcp/overview) and
[Linear](https://linear.app/docs/mcp) use the generic remote OAuth flow.
[Slack](https://docs.slack.dev/ai/slack-mcp-server/) requires an eligible registered
confidential OAuth client and does not support DCR. No messaging bridge is used.
Without deployment registration Slack remains `setup_required`, and creation is
refused. A validated registration makes it `available` on both API surfaces;
users still must connect each named account explicitly. No production grants or
Slack app permissions are created by Armada setup.

### Provision the Slack registered client (operator only)

1. Register an **internal or Slack Marketplace-published app**, with MCP access
   eligible under Slack's rules. Unlisted apps are not eligible. Obtain any
   workspace/admin approval externally; Armada does not create or approve apps.
2. Register the exact dashboard callback
   `https://YOUR_DASHBOARD_ORIGIN/auth/mcp/callback`. It must match
   `ARMADA_DASHBOARD_URL` (default `https://armada.thevibecompany.co`).
3. Choose explicit **user scopes** required by your intended tools from
   [Slack's scope table](https://docs.slack.dev/ai/slack-mcp-server/).
   Start minimally, for example `channels:read users:read`; do not silently
   request every scope. Configure the same approved scopes on the Slack app.
   Token rotation is supported; non-expiring user tokens are also accepted.
4. Provide the following JSON to the sealing script on **stdin through your
   secret manager**, never command arguments, source files, fixtures or logs.
   The placeholders below are documentation only:

   ```json
   {
     "client_id": "REGISTERED_APP_CLIENT_ID",
     "client_secret": "REGISTERED_APP_CLIENT_SECRET",
     "issuer": "https://mcp.slack.com",
     "resource": "https://mcp.slack.com",
     "redirect_uris": ["https://YOUR_DASHBOARD_ORIGIN/auth/mcp/callback"],
     "token_endpoint_auth_method": "client_secret_post",
     "scope": "channels:read users:read"
   }
   ```

   With the deployment's `ARMADA_ENCRYPTION_KEY` and `ARMADA_DASHBOARD_URL`
   available securely in the operator environment, run
   `bun scripts/seal-slack-mcp-client.ts` with that stdin. Its only stdout is
   base64 AES-256-GCM ciphertext using Armada's existing encryption scheme.
   Store this ciphertext as server-only `ARMADA_SLACK_MCP_CLIENT_ENC` and deploy.
   No new CLI operation or public client registration endpoint is introduced.
5. The server validates/decrypts registration before startup. Partial, wrong-key,
   wrong-callback, wrong-issuer/resource, wrong-auth-method or unknown-scope
   configuration fails closed with a redacted error. Never set this variable
   in the dashboard/browser environment. Public catalog/DTOs contain no
   registration, secret, or token. Each instance stores its own sealed grant
   and pending state; reconnect uses the current deployment registration.

The pinned transport is `https://mcp.slack.com/mcp`, but Slack's published
[protected-resource metadata](https://mcp.slack.com/.well-known/oauth-protected-resource)
uses audience `https://mcp.slack.com`. The
[authorization metadata](https://mcp.slack.com/.well-known/oauth-authorization-server)
advertises `client_secret_post`, PKCE S256, authorization at
`https://slack.com/oauth/v2_user/authorize` and token exchange at
`https://slack.com/api/oauth.v2.user.access`. Armada pins these identities before
sending any client secret/code, never attempts DCR, and normalizes Slack's
`ok`/`user` token response only within this registered-service policy.

To rotate registration, reseal and redeploy. Explicit reconnect uses the new
client; already-running sealed grants retain their original registration until
reconnected/revoked. Removing configuration disables new Slack creation/connect,
not existing grants: revoke those explicitly if access must be withdrawn.
No new migration is needed beyond #601's catalog/default migration above.
