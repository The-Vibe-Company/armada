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
[Slack](https://docs.slack.dev/ai/slack-mcp-server/) requires a registered
confidential OAuth client and does not support DCR. This deployment integration
does not yet support that client configuration: Slack is always setup-required,
and catalog creation is refused. Do not substitute a Slack messaging bridge or
present it as a ready connection. No production connections are created by setup.
