# Organization member help (#979)

The existing `org members list|add|role|remove` leaf commands now provide focused
`--help` and `-h` before login or I/O. Help intercepts exact command boundaries
only; email addresses, option values and other operation arguments keep their
existing parsing.

```sh
armada org members list --org my-team --json
armada org members add teammate@example.com --role member --org my-team
armada org members role teammate@example.com admin --org my-team
armada org members remove teammate@example.com --org my-team
```

Add defaults to member, with an optional `--role admin|member`.
Role changes instead take the new role as the second positional argument.
An explicit organization overrides the saved selection. All authenticated
operations retain server authorization; membership changes require an organization admin; help grants no membership authority.

Offline run.ts audit: 16 probes across four leaves, two flags and
no-session/fake-token modes. All fail before and succeed after, with zero
external requests. No membership mutation, staging/provider or TTY check was
performed. This help-only change uses the issue's audit exemption and preserves
operations, permissions and JSON output.
