# Credential account discovery (#979)

Focused help now works before login or I/O for `creds list`, `rename`,
`default`, `remove` and `rm`, with either `--help` or `-h`.
Only exact help invocations are intercepted; literal names, IDs and option values
continue through the existing operation parsers.

```sh
armada creds list --json
armada creds rename ACCOUNT_UUID personal-api
armada creds default ACCOUNT_UUID
armada creds remove ACCOUNT_UUID
armada creds rm openai
```

Replace ACCOUNT_UUID with the ID from list output. List returns metadata, not
secret values. Rename/default/remove always emit JSON; pass `--org <name>`
for organization accounts, otherwise they target personal scope.
Importantly, `rm <kind>` is the legacy kind-scoped removal, not an alias for
`remove <id>`. Authenticated actions still require server authorization.

Offline run.ts audit: 20 help probes across five commands, two flags and
no-session/fake-token modes; all fail before and succeed after, with no external
requests. No credential values, staging/provider or TTY checks are involved.
The issue's help-only live-audit exemption applies. No operation, credential
storage, permission or JSON output behavior changes.
