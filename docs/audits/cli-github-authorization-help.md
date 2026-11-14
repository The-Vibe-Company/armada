# GitHub authorization help (#979)

Focused help now covers `github connect`, `reconnect` and `install`
with either flag before authentication or I/O. Only exact help boundaries are
intercepted; operation arguments retain their existing parsers.

```sh
armada github connect --no-browser --timeout 300
armada github reconnect --no-browser --timeout 300
armada github install --no-browser --timeout 300
```

Operations require Armada login. They open an authorization URL by default;
no-browser instead writes instructions/URL to stderr. Successful output is JSON.
Timeout is an integer from 0 to 600 seconds, default 300. Zero still starts
authorization and checks status; it is not unconditional success.
On timeout, inspect `armada github status` before retrying.

Connect/reconnect wait for their authorization flow to connect. Install waits
for a newly observed installation, not merely an already-connected account.

Offline run.ts audit: 12 help probes across three leaves, both flags and
no-session/fake-token modes. All fail before and pass after with zero requests.
No browser or authorization flow is started. The issue's help-only audit
exemption applies; operations, timeouts, permissions and JSON schemas are
unchanged. No staging/provider/TTY evidence is claimed.
