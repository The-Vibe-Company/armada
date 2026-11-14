# Provider onboarding help (#979)

This help-only slice fills the missing `org connect` and `org connect boat`
help boundaries and refreshes existing Modal/setup guidance. All four paths
accept `--help` or `-h` before authentication or I/O.

```sh
armada org setup --org my-team --json
armada org connect boat --org my-team --file /private/boat-key
armada org connect modal --org my-team --file /private/modal.json
```

Setup reports configuration, not proof of a working lifecycle. Connect requires
an organization admin after login; explicit `--org` overrides a saved selection.
Boat takes an API key. Modal takes JSON with token_id/token_secret or a
whitespace-separated token pair. Use stdin/hidden input or private files,
never credential arguments; do not commit those files.

Offline run.ts audit: 16 probes across four help paths, both flags and
no-session/fake-token modes. Eight pre-existing setup/Modal probes succeed
before; all 16 succeed afterward. No credentials, native login or external
requests are used. The issue's help-only audit exemption applies; no live
provider/staging/TTY evidence or authenticated behavior change is claimed.
