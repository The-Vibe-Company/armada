# Docker snapshot get/rebuild help (#979)

The existing Docker snapshot commands now offer exact-boundary `--help` and
`-h` before login or I/O. The legacy `golden` spelling remains usable, while
guidance displays `snapshot`. This changes discovery only, not operations.

```sh
armada snapshot get --help
armada snapshot rebuild --help
armada snapshot list --provider docker --org ORG_UUID --json
armada snapshot get SNAPSHOT_UUID --provider docker --org ORG_UUID
armada snapshot rebuild SNAPSHOT_UUID --provider docker --org ORG_UUID --request-id NEW_UUID
```

Replace the uppercase placeholders with real UUIDs. Get always emits JSON.
Rebuild uses saved repositories/setup on the original host and leaves the old
snapshot unchanged. Its request UUID must differ from the old snapshot UUID.
The CLI generates a request UUID if omitted and prints it to stderr before
submission. After an uncertain outcome, inspect that ID and reuse it on retry.

Offline run.ts discovery audit: 16 probes across two commands, two spellings,
two help flags and no-session/fake-token modes. All fail before and pass after,
with zero external requests. No provider, staging or TTY results are claimed.
This help-only slice uses the issue's audit exemption; authenticated behavior,
permissions, output schemas and operation argument parsing are unchanged.
