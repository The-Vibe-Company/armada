# Remote Docker-host management help (#979)

Focused help now covers `host list`, `show`, `limits` and `revoke`
with both flags before login or I/O. This does not alter local daemon commands.

```sh
armada host list --org ORG_UUID --json
armada host show workstation --org ORG_UUID --json
armada host limits workstation --org ORG_UUID --cpus 2 --memory 4GiB
armada host revoke HOST_UUID --org ORG_UUID
```

Replace UUID placeholders with real IDs. Select an organization first or supply
its UUID explicitly. Show/limits accept exact unambiguous non-revoked names or
UUIDs; show can inspect a revoked host by UUID. Revoke takes only a UUID.

Limits requires at least one override or auto reset. Overrides can combine;
CPU must be at least 0.01 and sandbox count a positive integer. Auto resets all
limits and cannot combine with overrides. Container changes apply on next
start/resume; inspect policy with show. Server authorization remains unchanged.

Offline run.ts audit: 16 probes across four leaves, both flags and
no-session/fake-token modes; all fail before and pass after with zero requests.
No host, daemon or policy is changed. Exact-boundary help leaves operation
arguments to existing parsers. The issue's help-only exemption applies;
no staging/provider/TTY evidence or operation behavior changes are claimed.
