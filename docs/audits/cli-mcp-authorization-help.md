# MCP authorization help (#979)

Focused help now covers `mcp connect`, `reconnect` and `revoke` with
either flag before login/I/O. Exact boundaries only; operation arguments retain
their parsers.

```sh
armada mcp connect CONNECTION_UUID --org ORG_UUID --no-browser --timeout 300
armada mcp reconnect CONNECTION_UUID --org ORG_UUID --no-browser --timeout 300
armada mcp revoke CONNECTION_UUID --org ORG_UUID
```

Use registry IDs from list, not sandbox IDs. These authenticated commands
require organization selection and server authorization. Reconnect revokes
existing authorization before starting again. Revoke is not registry deletion.

When connect returns an authorization URL, the browser opens unless no-browser
is set, which prints instructions/URL to stderr. Timeout is an integer from
0 to 600 seconds, default 300. Zero still starts authorization and checks status.
A URL alone is not success; inspect status after timeout. Successful output
is always JSON even without the flag.

Offline run.ts audit: 12 help probes across three leaves, both flags and
no-session/fake-token modes; all fail before and pass after, zero requests.
No authorization, browser or revocation occurs. This help-only slice uses the
issue's live-audit exemption and preserves operations, permissions and JSON.
No staging/provider/TTY evidence is claimed.
