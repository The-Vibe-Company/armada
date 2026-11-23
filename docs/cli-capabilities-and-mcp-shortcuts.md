# CLI snapshot capabilities and MCP connections

## Snapshot capabilities

Set `ORG_UUID` to the organization ID from `armada org list --json` before running the examples.

```sh
armada api golden/capabilities
armada api golden/capabilities '{"provider":"modal","org":"ORG_UUID"}'
```

This calls authenticated `POST /api/v1/golden/capabilities` with optional `provider` and `org`. Pass `org` in the request body when selecting an organization. The response is exactly `{provider,maxGoldens}` with `maxGoldens: number | null`. Null is unbounded/unknown, never zero or a locally assumed Boat limit.

## MCP connection definitions

Create a public HTTPS connection with automatic OAuth discovery:

```sh
armada api mcp/create '{"org":"ORG_UUID","name":"Docs","url":"https://mcp.example.com/mcp","scope":"personal","transport":"http","authType":"auto"}'
```

For full definitions and write-only authentication values, redirect JSON on stdin:

```sh
armada api mcp/create - < /private/connection.json
armada api mcp/update - < /private/replacement.json
```

Include the organization UUID in both bodies and the connection ID in the update.
See the [MCP administration routes](cli-admin.md#mcp-connections) for authorization.
