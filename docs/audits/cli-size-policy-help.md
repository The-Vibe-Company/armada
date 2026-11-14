# Snapshot size-policy discovery (#979)

This help-only slice adds exact-boundary `snapshot size-policy --help` and
`snapshot size-policy -h` before authentication or file/network access.
The legacy `golden size-policy` spelling still works; displayed guidance uses
the user-facing name `snapshot`. Existing operation parsing and JSON are unchanged.

Inspect defaults:

```sh
armada snapshot size-policy starter --provider modal --org my-team
```

Replace all defaults (not a partial patch) from a versioned JSON file:

```sh
armada snapshot size-policy starter --provider modal --file policy.json
cat policy.json | armada snapshot size-policy starter --provider modal --file -
```

These updates affect future launches only. Omitting `--file` inspects defaults.
Output includes the server's version and configured repository selectors as JSON.

Offline audit: source CLI help probes in no-session and fake-token modes,
with synthetic HTTP 401 responses only. No staging credentials, live provider,
interactive terminal, production or lifecycle verification is claimed.
The issue's help-only exemption applies; authenticated behavior is not changed.

The root usage inventory produced 308 long/short-help probes (including repeated
size-policy coverage) across both auth modes: 202 nonzero exits before, 194 after.
All eight size-policy probes changed from exit 2 to exit 0. Other failures remain
out of this slice; this inventory does not cover undocumented subcommands or
authenticated operations. The focused regression test also fails on the original
implementation and passes with this change.
