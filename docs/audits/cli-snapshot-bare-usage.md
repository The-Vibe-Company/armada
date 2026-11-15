# Bare snapshot usage (#979)

## Selected slice

Baseline bare snapshot/golden can enter profile/organization preparation before
reporting a missing subcommand; with no selected profile it falls back to the
full root command tree rather than the focused snapshot index. Show the existing
snapshot family help before account/preference preparation for only these exact
single-command forms. Preserve exit 2 for missing subcommand; explicit --help/-h
still succeeds with exit 0. No valid operation, API, authentication, permission,
profile storage or capability changes. Independent branch from fresh main.

## Evidence and replay

One run-boundary regression covers both spellings under an unconfigured explicit
profile with account/network/stdin access forbidden. Baseline fails by accessing
account setup before discovery; candidate emits the existing snapshot index with
code 2 and empty stderr. Existing explicit-help and unknown-command tests retain
their distinct contracts. No production seam added.

```sh
bun packages/cli/src/main.ts --profile new-user snapshot
bun packages/cli/src/main.ts --profile new-user golden
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts scripts/armada-skill.test.ts
```

Both bare probes intentionally exit 2. To request successful discovery explicitly,
use snapshot --help. No args, flags or payloads are rewritten.

Offline evidence only, not staging/provider/TTY evidence. Pure client amendment
applies. No authenticated operation performed. No whole-ticket completion claimed.

## Coordinator checks

After deployment run bare snapshot/golden under an unconfigured named profile
and with a selected org, including pipes. Confirm focused snapshot index, exit 2,
empty stderr and no login prompt; explicit help still exits 0. No provider
mutation or production check required.
Migration files: none. Deployment prerequisites: none.
