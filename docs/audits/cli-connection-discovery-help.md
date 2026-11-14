# Connection discovery help (#979)

Focused help now covers `creds presets`, `creds connect` and `creds test`
with either help flag before authentication or I/O. Only exact help invocations
are intercepted. No connection is created or tested by help.

```sh
armada creds presets --json
armada creds connect openai --name personal --file /private/api-key
armada creds test SANDBOX_UUID --model deployment-name --json
```

Presets are built-in metadata and need no login. Connect requires a preset and
name; key input is stdin/hidden input or a private file, never argv or JSON.
Use preset metadata to select supported model, address and API-version options.
Harness-model presets reject those overrides; chosen-model presets require
models and an address unless fixed. Fixed-address presets reject address overrides.
Official Azure addresses are checked with a tiny billable request per deployment
before saving; failed checks save nothing.

Test uses an existing sandbox's bound connection, not a raw key or URL. It can
make a billable request; success is not full harness compatibility and failure
exits 1. Omit organization for personal connect scope.

Offline run.ts audit: 12 probes across three commands, both flags and
no-session/fake-token modes. All fail before and pass after, without external
requests. This help-only slice uses the ticket's live-audit exemption; no live
provider/staging/TTY evidence is claimed and operation behavior is unchanged.
