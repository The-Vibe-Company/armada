# Unknown snapshot-command JSON errors (#979)

## Selected slice

Root unknown-command JSON was fixed separately. Baseline unknown snapshot
subcommands still return plain text even with --json, including the legacy
golden spelling. Route this one fallback through the same typed usage formatter.
Exit 2 and empty stdout remain; human text keeps the original diagnostic plus
standard next-step guidance. User-facing diagnostics use snapshot for both
spellings. No valid operation, API, permission or capability changes.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing unknown-command run-boundary test across root, snapshot
and golden, in human/JSON modes with network/stdin forbidden. An explicit org
selector avoids unrelated preference lookup. Baseline fails JSON parsing for
snapshot; candidate passes the same usage envelope and exit/output checks for
all cases. No duplicate owner or production seam.

```sh
bun packages/cli/src/main.ts snapshot frobnicate --json
bun packages/cli/src/main.ts golden frobnicate --json
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts scripts/armada-skill.test.ts
```

Both probe commands intentionally exit 2 and emit JSON stderr, not stdout.
The error code is usage, with the unknown snapshot command and root-help next
step in the message. Capture/check stderr and exit status in scripts.

Offline client evidence only, not staging/provider/TTY evidence. Pure client
amendment applies. No authenticated operation performed. No whole-ticket
completion claimed.

## Coordinator checks

After deployment probe an unknown snapshot command using both spellings and
with/without --json, including pipes. Confirm exit 2, empty stdout, snapshot
wording and parseable JSON stderr. No provider mutation or production check
required. Migration files: none. Deployment prerequisites: none.
