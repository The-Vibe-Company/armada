# Sandbox recovery discovery (#979)

Focused help now covers `recovery` and `bind-credential` with either flag
before login/I/O. Exact boundaries only; sandbox IDs and option values retain
their operation parsers.

```sh
armada recovery SANDBOX_UUID --org ORG_UUID --json
armada bind-credential SANDBOX_UUID --credential-id ACCOUNT_UUID --org ORG_UUID
```

Recovery reads work-recovery information, not account rebinding. Bind-credential
is owner-only legacy Modal binding recovery: stop safely first, and note that it
does not restart the sandbox. Supply credential-account IDs from creds list,
never secret values. Both commands retain server authorization and always emit
JSON; get sandbox IDs from list.

Offline run.ts audit: eight long/short-help probes in no-session/fake-token
modes show broad root help before and focused guidance after, zero requests.
No sandbox or credential is read/changed. The help-only live-audit exemption
applies; no staging/provider/TTY evidence or operation, permission or output
changes are claimed.
