# Sandbox lifetime/deletion help (#979)

Focused help now covers `extend` and `rm` with either flag before login/I/O.
Only exact help boundaries are intercepted; IDs, durations and confirmation
arguments retain their existing parsers.

```sh
armada extend SANDBOX_UUID --ttl 30m --org ORG_UUID --json
armada rm SANDBOX_UUID --yes --org ORG_UUID --json
```

Extend takes a positive integer duration with optional s/m/h/d; bare numbers
are seconds. Server/provider limits and state still apply; this is not
unbounded lifetime. Output is always JSON.

Rm is permanent deletion of a stopped sandbox, including disk and recovery
archives, not a stop operation. Explicit yes is required. Inspect status and
preserve needed work before deleting. Both commands use sandbox UUIDs from list
and retain server authorization.

Offline run.ts audit: eight no-session/fake-token long/short-help probes.
Before they return broad root help; after they return focused guidance, zero
requests. No lifetime or deletion operation is performed. This help-only
slice uses the issue's audit exemption; operations, permissions, exit codes
and JSON output remain unchanged. No staging/provider/TTY evidence is claimed.
