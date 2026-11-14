# Organization invitation help (#979)

Focused `--help` and `-h` now work before login/I/O for the five existing
`org invitations` leaves: create, list, resend, revoke and accept.
Only exact help boundaries are intercepted; operation arguments keep their parsers.

```sh
armada org invitations create teammate@example.com --org my-team
armada org invitations list --org my-team --json
armada org invitations resend INVITATION_UUID --org my-team
armada org invitations revoke INVITATION_UUID --org my-team
armada org invitations accept --file /private/invitation-token
```

Management requires organization-admin authorization and an organization selected
by `--org` or `org use`. Creation defaults to member, with optional
`--role admin|member`. List supplies invitation IDs, never acceptance tokens.
Sent means provider acceptance, not confirmed inbox delivery.

Accept uses the signed-in identity and reads its token from stdin or a private
file, never argv. It does not accept `--org`; server validation still applies.
Do not commit token files. No token values are used by this change.

Offline run.ts audit: 20 help probes across five leaves, two flags and
no-session/fake-token modes. All fail before and pass after, zero requests.
No invitation is sent, revoked or accepted. This help-only slice uses the
issue's live-audit exemption; no staging/provider/TTY claims or operation changes.
