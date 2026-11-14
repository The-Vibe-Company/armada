# MCP read discovery help (#979)

Focused help now covers `mcp list`, `catalog`, `status` and
`sandbox-connections` with either flag before login/I/O.
Only exact help boundaries are intercepted; operation selectors retain parsing.

```sh
armada mcp list --org ORG_UUID --json
armada mcp catalog --org ORG_UUID --json
armada mcp status CONNECTION_UUID --org ORG_UUID --json
armada mcp sandbox-connections SANDBOX_UUID --org ORG_UUID --json
```

These authenticated reads require an organization, selected with org use or
explicit UUID. All emit JSON even without the flag. List concerns visible
registry connections; status takes a connection ID from that list.
Sandbox-connections instead takes a sandbox UUID and reads actual bound
metadata without mutating bindings. Catalog reads service metadata, not a
connection-creation action. Server authorization remains unchanged.

Offline run.ts audit: 16 help probes across four leaves, both flags and
no-session/fake-token modes; all fail before and succeed after, zero requests.
The issue's help-only audit exemption applies. No MCP/provider/staging/TTY
evidence or operation/permission/JSON changes are claimed.
