# GitHub maintenance help (#979)

Focused help now covers `github status`, `manage`, `refresh` and
`disconnect` with either help flag before login or I/O.
Only exact boundaries are intercepted; IDs and literal arguments retain parsing.

```sh
armada github status --json
armada github manage INSTALLATION_ID --no-browser
armada github refresh SANDBOX_UUID --json
armada github disconnect
```

Manage takes an installation ID from status, not a sandbox UUID. With no-browser,
it prints the settings URL to stdout; otherwise it opens the browser.
Refresh instead takes a sandbox ID and requests credential refresh under server
authorization; it is not account reconnect. Status, refresh and disconnect always
emit JSON even without the flag. Disconnect guidance points back to connect.

Offline run.ts audit: 16 probes across four leaves, both flags and
no-session/fake-token modes. All fail before and pass after with zero requests.
No browser, refresh or disconnect occurs. This help-only change uses the issue's
live-audit exemption and preserves operations, permissions and JSON schemas;
no staging/provider/TTY evidence is claimed.
