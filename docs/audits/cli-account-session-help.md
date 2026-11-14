# Account/session help (#979)

Focused help now covers `account status`, `account logout` and `logout`
with either help flag before authentication or I/O. Exact help boundaries only;
other arguments retain existing parsing.

```sh
armada account status --json
armada account logout
armada logout
```

Status calls the server and always emits JSON, not a local session-file report.
Account logout first signs out the current personal session remotely and then
clears local login. It does not support service-token authentication; if
ARMADA_TOKEN is present, remove it from that command's environment so the
personal login can be used. Local logout only clears saved login, without a
server request, and does not revoke service tokens or unset environment values.

Offline run.ts audit: 12 help probes across three paths, both flags and
no-session/fake-token modes. Before, eight account leaf probes fail and four
logout probes return broad root help. After, all provide focused help.
No session is cleared or remotely signed out; zero requests. This help-only
slice uses the issue's live-audit exemption and preserves operation behavior.
No staging/provider/TTY evidence is claimed.
