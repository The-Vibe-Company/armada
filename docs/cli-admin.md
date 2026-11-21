# Administrative operations from the CLI

Use the dashboard for interactive administration. For scripts,
`armada api ROUTE [JSON|-]` sends a POST to `/api/v1/ROUTE` and prints the JSON
response. Use `-` to read a JSON request from stdin. The server applies the same
authorization rules as it does for other API callers.

## API keys

Sign in personally to manage keys. Send `org` explicitly by UUID or name if
you belong to multiple organizations. Keep the creation response out of logs
and store its `token` field securely. This field is returned only at creation.

| Removed command | Replacement |
| --- | --- |
| `token create` | `armada api token/create '{"label":"worker","org":"ORG_UUID","expires":"30d"}'` |
| `token ls` | `armada api token/list` |
| `token revoke` | `armada api token/revoke '{"id":"TOKEN_UUID"}'` |

Expiry accepts `30d` (default), `90d`, `1y`, or `never`.
Use `armada whoami --json` to verify the active login or API key.

## Routines

Send the organization UUID in `org` and use routine UUIDs from the list response.
For updates and state changes, read the current version first and pass it as
`expectedVersion`. When the version conflicts, inspect the latest configuration
before deciding whether to retry.

| Removed command | Replacement | JSON body fields |
| --- | --- | --- |
| `routine create` | `armada api routines/create -` | `org`, `scope`, `name`, `templateId`, `templateRevision`, `prompt`, `cron`, `timezone`, optional `ttlSeconds` and `maxRunsPerDay` |
| `routine list` | `armada api routines/list -` | `org` |
| `routine show` | `armada api routines/get -` | `org`, `id` |
| `routine update` | `armada api routines/update -` | `org`, `id`, `expectedVersion` and every mutable configuration field |
| `routine enable` | `armada api routines/enable -` | `org`, `id`, `expectedVersion` |
| `routine pause` | `armada api routines/pause -` | `org`, `id`, `expectedVersion` |
| `routine delete` | `armada api routines/delete -` | `org`, `id`, `expectedVersion` |
| `routine runs` | `armada api routines/history -` | `org`, `id` |

For example, run `armada api routines/get '{"org":"ORG_UUID","id":"ROUTINE_UUID"}'`.
A full update supplies `name`, `templateId`, `templateRevision`, `prompt`, `cron`,
`timezone`, `ttlSeconds` and `maxRunsPerDay`. Keep the existing values for
fields you intend to retain. Creation starts paused. Enabling schedules the
next occurrence. Pause and delete prevent new admissions while admitted
runs can finish. Use the history route to see admission and task outcomes.
