# Sandbox lists, bindings and JSON output

These are the sandbox list and JSON output contracts. See the [CLI/dashboard feature matrix](cli-web-parity.md) for the wider workflow.

## Filter and page sandboxes

```sh
armada org use my-org
armada list --json
armada list --status deleted --json
armada list --agent codex --golden GOLDEN_UUID --owner me --page 2 --limit 25 --json --page-info
armada list --harness claude --owner USER_UUID --org ORG_UUID --json
```

| Option | Behavior |
|---|---|
| `--status STATUS` | One known sandbox status. Omitted status excludes deleted; use `--status deleted` explicitly. |
| `--agent` / `--harness` | Aliases for one harness filter. Supplying both is rejected. |
| `--golden UUID` | A golden ID, not its name. Discover it with `golden list --json`. |
| `--owner UUID` / `--owner me` | Filter by user; the authenticated server resolves `me`. |
| `--page N` | 1-based page, from 1 to 1,000,000. Default 1. |
| `--limit N` | From 1 to 200. Default 25, matching the dashboard. |
| `--org UUID` | Override the saved organization for this request. |
| `--page-info` | Include exact filtered totals and navigation metadata. |

Invalid, duplicate and unsupported list flags fail before the HTTP request. `--` remains the option terminator. There is no sandbox-list provider filter in this contract.

The list is newest first, with ID as a stable tie-breaker. Its total counts only rows authorized for this caller that match all filters; it is not the number of rows in the returned page. A page beyond the end is empty but retains the exact filtered total.

## Compatible JSON shapes

`armada list --json` preserves the existing envelope:

```json
{"sandboxes":[]}
```

`--page-info` opts into additional pagination fields:

```json
{"sandboxes":[],"total":0,"page":1,"limit":25,"hasMore":false,"nextPage":null}
```

The authenticated HTTP `sandbox/list` endpoint and read-only MCP `list` operation return the full page shape. Existing CLI consumers do not need a new flag to keep receiving `{sandboxes:[...]}`. `golden list --json` retains its separate array shape.

## Read existing connection bindings

```sh
armada mcp sandbox-connections SANDBOX_UUID --org ORG_UUID --json
```

The response is the authorized `{connections:[...]}` metadata for that sandbox. This command does not bind, connect, revoke or otherwise mutate a grant. Select an org first or pass `--org`; a sandbox UUID does not determine authorization scope.

For full MCP definitions or authentication headers, use a file or stdin rather than arguments:

```sh
armada mcp add --file /secure/connection.json --org ORG_UUID
armada mcp update CONNECTION_UUID --file /secure/replacement.json --org ORG_UUID
```

The simple public/OAuth shortcut is `armada mcp add NAME URL`. It defaults to personal scope and HTTP automatic discovery; `--scope org` requests sharing, subject to server permissions. Do not put bearer values, headers or credentials in URL parameters.

## Golden IDs and sandbox privacy

`armada golden list --json` includes safe `id` and `orgId`, provider-neutral sandbox/snapshot IDs, Modal binding metadata and compatibility Boat aliases. The ID is the selector for visibility changes:

```sh
armada golden visibility GOLDEN_UUID --visibility private --org ORG_UUID
```

Launch output reports the stored sandbox visibility. A private fork of an org golden is **private**; the source golden's management credential scope remains **org**. On an older server that omits sandbox visibility, the CLI falls back to the golden's visibility for display.

A configured directory chosen with `launch --repo` is returned as `repositoryDir` in launch/list/status/detail metadata. It remains fixed for that sandbox. Filter, page and JSON formatting options do not change sandbox privacy, provider routing or repository context.
