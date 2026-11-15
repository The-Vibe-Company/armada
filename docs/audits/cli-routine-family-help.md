# Routine family navigation (#979)

## Selected slice

Baseline root routine help (both spellings) prints the dense schedule-option
inventory with no examples, even though all eight leaves now have focused help.
Replace exact root help with a command map and owner/version/outcome guidance.
Bare routine behavior, scheduling, mutations, parsers, APIs, permissions, output
schemas and capabilities are unchanged. Independent branch from fresh main.

## Evidence and replay

Extended the existing run-boundary focused-help table; it fails on baseline
missing Usage heading and passes after navigation, with profile selection and
network/stdin forbidden. The terminator remains parser input. Removed the obsolete
family flag inventory test, leaving discovery with one primary owner.

The skill-document contract test now reads all focused routine leaf pages too,
following the template fix. Only leaf Usage headings become contracts; generic
family headings cannot authorize unknown subcommands. Negative controls retain
unknown commands, obsolete interval syntax and command-specific flag rejection.

```sh
bun packages/cli/src/main.ts routine --help
bun packages/cli/src/main.ts routine -h
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/routines-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No authenticated operations performed. This completes routine help
navigation, not the whole #979 campaign.

## Coordinator checks

After deployment inspect both root help spellings in pipes and an unconfigured
named profile. Confirm the map leads to focused leaves and distinguishes new
admissions from admitted runs, and launch from task success. No actual scheduling,
provider mutation or production check required.
Migration files: none. Deployment prerequisites: none.
