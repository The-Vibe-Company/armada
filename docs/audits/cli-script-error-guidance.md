# Script error/stream guidance (#979)

## Selected slice

Baseline root help lists exit codes but does not explain JSON error placement,
partial stdout, or mixed stderr progress. The onboarding guide lacks a safe
status-first capture example. Add those existing-contract details, not new
output behavior or guarantees. Common typed JSON errors are distinguished from
all stderr being one JSON document. Independent branch from fresh main.

## Evidence and replay

Source audit of run.ts confirms common typed errors use stderr and existing
exit-code mapping. Existing run-boundary tests own unknown-command human/JSON
errors and profile failures; the skill-doc contract validates advertised CLI
commands. No new prose-only test or production seam added.

```sh
bun packages/cli/src/main.ts --help
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts scripts/armada-skill.test.ts
```

Offline documentation evidence only, not staging/provider/TTY evidence. Help-only
amendment applies. No authenticated operation performed. No whole-ticket
completion claimed.

## Coordinator checks

After deployment read root help and the onboarding script section. Optionally
use a deliberately unknown command with --json to confirm exit 2 and stderr
placement without authentication. Inspect shell capture/cleanup example locally;
no real values, tokens, provider mutation or production checks needed.
Migration files: none. Deployment prerequisites: none.
