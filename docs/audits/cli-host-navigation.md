# Host navigation help (#979)

## Selected slice

Offline baseline: both root host help spellings return one compressed usage
line with no example. Existing leaf pages are more helpful but hard to discover.
This independent help-only slice separates authenticated account commands from
local Docker-machine wrappers. No registration, installer, API, secret delivery
or sandbox operation changes. No new capability or renamed flag.

## Evidence and replay

The existing run-boundary help test was extended with the host family. It fails
on baseline because host help has no example, then passes with the navigation
page, for both spellings with profile selection and network/stdin I/O forbidden.

```sh
bun packages/cli/src/main.ts host --help
bun packages/cli/src/main.ts host -h
bun test packages/cli/test/onboarding-help.test.ts
```

This is offline discovery evidence, not a live provider or TTY audit. The issue's
help-only amendment applies. Other command families remain separate slices.

## Coordinator checks

After deployment, inspect both host help spellings in a terminal and pipe;
confirm account versus machine-local commands and examples read clearly.
No machine registration or provider mutation is needed to validate this slice.
Migration files: none. Deployment prerequisites: none. Production checks: none.
