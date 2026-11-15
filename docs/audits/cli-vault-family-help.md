# Application-vault family navigation (#979)

## Selected slice

Baseline vars/secrets root help (both spellings) prints the same combined page
without examples despite all leaves having focused help. Separate the command
maps and emphasize readable versus write-only data, safe inputs, scope and
metadata. Only exact root help changes. Bare-family behavior, broader help
recognition, parsers, value/lifecycle handling, API, permissions and JSON schemas
are unchanged. Independent branch from fresh main, not stacked.

## Evidence and replay

Extended existing run-boundary focused-help table; fails on baseline missing
Usage heading, passes after navigation with profile selection and network/stdin
forbidden. Terminators remain parser input. Removed obsolete combined-family
flag inventory, leaving focused discovery with one primary owner.

Skill-document contracts now collect all focused vault leaf help. Only leaf
Usage headings authorize command paths, not generic family navigation. Negative
controls reject unknown variable commands, secret reads and wrong-leaf flags.

```sh
bun packages/cli/src/main.ts vars --help
bun packages/cli/src/main.ts secrets -h
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/application-vault-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No real values read/written. Completes selected vault navigation slice,
not the entire #979 campaign.

## Coordinator checks

After deployment inspect both spellings for both families in pipes and an
unconfigured named profile. Confirm maps lead to focused leaves, value versus
metadata output is clear, and secrets have no read capability. No real value
reads/writes, provider mutation or production check required.
Migration files: none. Deployment prerequisites: none.
