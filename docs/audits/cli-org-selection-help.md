# Organization selection help (#979)

Focused help now covers `org list`, `org use`, `org current` and
`org create`, with either help flag before authentication or I/O.

```sh
armada org list --json
armada org use my-team
armada org current
armada org use none
armada org create my-team --json
```

Selecting an organization by exact name or UUID resolves it against your
organizations after login. The default is stored locally per Armada server.
For commands that consume the saved default, explicit `--org` overrides it.
Clearing with `none` is local and does not delete the organization.
Current only reads saved preferences: its JSON contains the saved UUID or null,
and it does not validate current access or membership.

List and create require login. Creation makes you admin; configure the provider
next using `org connect boat|modal --org <id>`, with secure credential input,
not credentials in command arguments.

Offline run.ts audit: 16 help probes across four commands, both flags and
no-session/fake-token modes; all fail before and pass after with no requests.
Help is exact-boundary only; operation arguments retain existing parsing.
This help-only slice uses the issue's live-audit exemption; no staging/TTY
evidence or operation behavior changes are claimed.
