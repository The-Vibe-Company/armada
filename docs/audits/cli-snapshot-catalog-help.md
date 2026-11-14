# Snapshot catalog help (#979)

The ranked nested-help finding also affected catalog discovery:
`snapshot list --help` and `snapshot capabilities --help` rejected their help
flags. This help-only slice adds exact-boundary discovery for those two commands,
with both `--help` and `-h`, before authentication or file/network access.
The legacy `golden` spelling works too; guidance uses `snapshot`.

Examples:

```sh
armada snapshot list --provider modal --org my-team --json
armada snapshot list --provider docker --org ORG_UUID --json
armada snapshot capabilities --provider modal --org my-team --json
```

List visible snapshots to obtain reusable IDs. Docker listing requires an explicit
organization UUID. Capacity discovery supports Boat and Modal, not Docker; a null
maximum means unbounded or unknown and is not a count of available slots.

Offline audit: 16 run.ts help probes across two commands, two aliases, two help
flags and no-session/fake-token modes. All 16 failed before and succeed after,
without network requests. No live provider, human login or TTY claims are made.
This is covered by the issue's help-only audit exemption. Operation parsing,
permissions, JSON output and authenticated behavior remain unchanged.
