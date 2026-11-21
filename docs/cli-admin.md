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
After injecting the key as `ARMADA_TOKEN`, verify it with `armada whoami --json` in the agent environment.

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

## Organizations and membership

Sign in personally. Include the organization name or UUID in `org` for the
membership routes. Adding a member directly requires an existing Armada account
and grants membership immediately. Use an invitation to invite someone by email.

| Removed command | Replacement | JSON body fields |
| --- | --- | --- |
| `org create` | `armada api org/create -` | `name` |
| `org members list` | `armada api members/list -` | `org` |
| `org members add` | `armada api members/add -` | `org`, `email`, `role` |
| `org members role` | `armada api members/role -` | `org`, `email`, `role` |
| `org members remove` | `armada api members/remove -` | `org`, `email` |

Use `member` or `admin` for the role. Creating an organization makes you its
first admin.

## Organization invitations

Use an organization UUID in `org`. Use the invitation ID from the list response
to resend or revoke. Creating an invitation leaves membership pending until the
recipient explicitly accepts. The recipient must sign in personally with the
matching verified email. Supply acceptance JSON through stdin and keep the token
out of command arguments and logs.

| Removed command | Replacement | JSON body fields |
| --- | --- | --- |
| `org invitations create` | `armada api org/invitations/create -` | `org`, `email`, `role` (`member` or `admin`) |
| `org invitations list` | `armada api org/invitations/list -` | `org` |
| `org invitations resend` | `armada api org/invitations/resend -` | `org`, `id` |
| `org invitations revoke` | `armada api org/invitations/revoke -` | `org`, `id` |
| `org invitations accept` | `armada api org/invitations/accept -` | `token` |

See [organization invitations](cli-invitations.md) for delivery and acceptance details.

## Template authoring

Use the organization UUID in `org` and the template UUID in `id`. Organization
templates require administrator permission for writes.

| Removed command | Replacement | JSON body fields |
| --- | --- | --- |
| `template create` | `armada api templates/create -` | `org`, `name`, `scope` (`personal` or `org`), `definition` |
| `template publish` | `armada api templates/publish -` | `org`, `id`, `expectedRevision`, complete `definition` |
| `template delete` | `armada api templates/delete -` | `org`, `id`, `expectedRevision` |

See the [definition fields](templates-cli.md#definition-and-api). Use the current
revision from `armada template get ID --org ORG_UUID --json` as `expectedRevision`.
On a conflict, inspect the current template before deciding whether to retry.

## GitHub refresh and snapshot retirement

| Removed command | Replacement | JSON body fields |
| --- | --- | --- |
| `github refresh` | `armada api github/refresh -` | Sandbox UUID in `id`, optional `org` |
| `snapshot retirement dry-run` | `armada api golden/retirement/dry-run -` | Snapshot UUID in `id`, optional `org` and `limit` |
| `snapshot retirement reconcile` | `armada api golden/retirement/reconcile -` | Snapshot UUID in `id`, reviewed `receipts` as an array of strings, optional `org` and `limit` |

Only the sandbox owner can request GitHub refresh. Review the retirement dry-run
output and pass the selected receipt strings to reconcile. Reconcile queues
eligible work. Check the resulting status to confirm deletion. See [historical
retirement](golden-rebuild-retention.md#historical-dry-run-and-reconciliation) for
receipt format and authorization.
