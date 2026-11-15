# Unknown-command JSON errors (#979)

## Selected slice

Baseline an unknown root command returns exit 2 and human text even with --json,
unlike common typed usage errors. Route only this root fallback through the
existing AuthError usage formatter. Human output retains its original diagnostic
and gains the standard next-step guidance; JSON uses the existing error envelope
on stderr. No new command, flag, API, authentication or server behavior.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing run-boundary unknown-command test to both output modes,
with network/stdin forbidden: baseline fails JSON.parse on plain text, candidate
passes. Both modes retain exit 2 and empty stdout. JSON is
`{"error":{"code":"usage","message":"unknown command 'frobnicate'. Run 'armada --help'."}}`.
No duplicate test owner or production seam added.

```sh
bun packages/cli/src/main.ts frobnicate --json
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts scripts/armada-skill.test.ts
```

The first command intentionally exits 2 and writes JSON to stderr. Scripts must
capture/check the exit status and stderr rather than piping only stdout to a
JSON parser. The envelope does not make invalid commands successful.

Offline evidence only, not staging/provider/TTY evidence. Pure client-side ticket
amendment applies. No authenticated operation performed. No whole-ticket
completion claimed.

## Coordinator checks

After deployment run an intentionally unknown command with/without --json, in a
script/pipe. Confirm exit 2, empty stdout, human recovery guidance and parseable
JSON stderr. No provider mutation or production check needed.
Migration files: none. Deployment prerequisites: none.
