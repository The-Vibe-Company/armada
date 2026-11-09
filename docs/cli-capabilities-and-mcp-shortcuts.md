# CLI capabilities and MCP URL creation

These CLI additions use the same canonical Armada HTTP contracts as web. Server-side authorization, capacity and connection policy remain authoritative; consolidated cross-package/deployment acceptance is coordinator-owned.

## Golden capabilities

```sh
armada golden capabilities --json
armada golden capabilities --provider modal --org <org-uuid> --json
```

This calls authenticated `POST /api/v1/golden/capabilities` with optional `provider` and `org`. It inherits `armada org use` selection; an explicit `--org` wins. The response is exactly `{provider,maxGoldens}` with `maxGoldens: number | null`. Null is unbounded/unknown, never zero or a locally assumed Boat limit. Text output labels that meaning. An unavailable backend or mismatched provider response fails; there is no Boat fallback, provider SDK or direct database access in CLI.

## Public/OAuth MCP URL shortcut

```sh
armada org use <org-uuid>
armada mcp add Docs https://mcp.example.com/mcp
armada mcp add SharedDocs https://mcp.example.com/mcp --scope org --org <org-uuid>
armada mcp connect <returned-connection-uuid>
```

`mcp add NAME URL` sends `POST /api/v1/mcp/create` with:

```json
{"org":"<selected-org-uuid>","name":"Docs","url":"https://mcp.example.com/mcp","scope":"personal","transport":"http","authType":"auto"}
```

Only `--scope personal|org` changes the shortcut's default scope. Explicit `--org` overrides persisted selection; a scope decision never replaces the server's membership/admin/grant checks. Creation returns the real connection metadata, not a connected claim. Use the existing connect command for discovery/browser consent and authenticated status polling; `--no-browser` and `--timeout` retain their existing behavior. Unconfigured backend/discovery failure must not become fake success.

The shortcut is for public/OAuth endpoint URLs, not credentials. Obvious userinfo, secret-like query parameters and URL fragments are refused without echoing the URL. Endpoint/DNS/SSRF/discovery validation remains backend-owned. Never place bearer tokens, header values or credential-bearing URLs on argv: use a full JSON definition via stdin/file for write-only authentication instead.

## Full definitions and immutable updates

Pinned stdio, custom headers and advanced OAuth options still use the existing full definition contract:

```sh
armada mcp add --file definition.json --org <org-uuid>
cat definition.json | armada mcp add --org <org-uuid>
armada mcp update <connection-uuid> --file replacement.json --org <org-uuid>
```

A URL shortcut cannot also supply `--file` or nonempty stdin. Full JSON creation remains unchanged. Updates still pass the full replacement definition to the server; immutable scope/org/grant rules are not reimplemented or loosened in CLI. `--scope` is a URL-create shortcut flag, not an update override; put creation scope in a full create definition when using JSON. The CLI does not dump imported definitions or write-only values; it displays only the server's metadata response.

`packages/cli/test/parity-shortcuts-api.test.ts` covers the actual command → authenticated canonical Request/body boundary, persisted preference reopen, explicit org override, nullable capacity, Modal failure/mismatch without fallback, URL defaults, file/stdin compatibility and ambiguous/credential-like input rejection. Existing connect/poll tests remain their behavior owner. This is source/contract evidence, not a deployed connection or capacity claim.

Validation of this CLI-only delta: full verify passed (421 pass, 4 skip, 0 fail; 425 tests across 74 files), as did standalone CLI/server builds, linux-x64 packaging and npm/Bun tarball/bin smoke. Only CLI source/docs/tests changed; root's wire decoding, dates, deadlines, shared server/core/dashboard and 2.4.0 release version were not modified. Consolidated integration and deployed acceptance remain coordinator work.
