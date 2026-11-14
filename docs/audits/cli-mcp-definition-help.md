# MCP definition help (#979)

Focused help now covers `mcp add` and `mcp update` with either flag before
login/I/O. Only exact help boundaries are intercepted; operation definitions
and selectors retain their existing parsers.

```sh
armada mcp add work-tools --service notion --org ORG_UUID
armada mcp add --file /private/connection.json --org ORG_UUID
armada mcp update CONNECTION_UUID --file /private/connection.json --org ORG_UUID
```

Add supports a service ID from catalog, a name/public OAuth HTTP URL shortcut,
or a JSON object from stdin/private file. URL shortcuts must not contain
credentials or combine with file/stdin JSON; scope defaults to personal.
Full definitions put scope inside JSON, not a scope flag.
Update uses a registry ID and JSON object; scope is immutable.
Keep authentication values in private files/stdin, never argv or committed files.
Organization selection and server authorization remain required; output is JSON.
Adding a definition does not invoke the separate connect operation.

Offline run.ts audit: eight help probes across two leaves, both flags and
no-session/fake-token modes; all fail before and succeed after, zero requests.
No definitions or secret values are read or sent. The issue's help-only
live-audit exemption applies; no staging/provider/TTY evidence or operation,
permission or output changes are claimed.
