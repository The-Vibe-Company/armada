# MCP registry management help (#979)

Focused help now covers `mcp rename`, `default`, `enable`, `disable`
and `delete` with either flag before login/I/O. Exact help boundaries only;
operation arguments retain their existing parsers.

```sh
armada mcp rename CONNECTION_UUID work-tools --org ORG_UUID
armada mcp default CONNECTION_UUID on --org ORG_UUID
armada mcp enable CONNECTION_UUID --org ORG_UUID
armada mcp disable CONNECTION_UUID --org ORG_UUID
armada mcp delete CONNECTION_UUID --org ORG_UUID
```

Use registry IDs from list, select an organization and retain server
authorization. Output is always JSON. Default takes positional on/off and
controls launch defaults, not authorization. Enable guidance points to status
for authorization state; disable is not deletion. Delete guidance points to
revoke for the separate authorization-revocation action.

Offline run.ts audit: 20 help probes across five leaves, both flags and
no-session/fake-token modes; all fail before and succeed after, zero requests.
No registry or authorization mutation occurs. This help-only slice uses the
issue's live-audit exemption and preserves operations, permissions and JSON;
no staging/provider/TTY evidence is claimed.
