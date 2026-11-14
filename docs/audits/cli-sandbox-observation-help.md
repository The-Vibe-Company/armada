# Sandbox observation help (#979)

Focused help now covers status, detail and wait with either flag before
authentication or I/O. Exact boundaries only: IDs and option values retain
their existing parsers.

```sh
armada status SANDBOX_UUID --org ORG_UUID --json
armada status SANDBOX_UUID --live --org ORG_UUID
armada detail SANDBOX_UUID --org ORG_UUID --json
armada wait SANDBOX_UUID --timeout 60 --org ORG_UUID --json
```

Status defaults to recorded state without a provider probe, not proof of
current readiness. Live status reads provider/prompt details.
Detail reads detailed information; wait performs a bounded server wait.
Wait accepts integer seconds from 0 to 600, default 60. Inspect the returned
state instead of assuming task completion merely because waiting returned.
All three retain server authorization and always emit JSON.

Offline run.ts audit: 12 long/short-help probes in no-session/fake-token modes.
Before they show broad root help; after they show focused help, zero requests.
No provider probes or waits occur. This help-only slice uses the issue's
live-audit exemption; no staging/provider/TTY evidence or operation, permission
or output changes are claimed.
