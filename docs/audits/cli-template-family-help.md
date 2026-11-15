# Template family navigation (#979)

## Selected slice

All six template leaves already have focused help. Baseline root `template
--help` / `-h` still show the dense family option inventory with no examples,
obscuring the command map. Replace only exact root help forms with a short
navigation page pointing to leaf help, plus scope, ID, reference and retry basics.
No operation parser, bare-command behavior, API, permission, JSON schema or
capability changes. This branch starts from fresh main, not stacked.

## Evidence and replay

The existing run-boundary help table now covers the template family and both
spellings with profile selection and network/stdin forbidden. It fails on
baseline for lack of a Usage heading, then passes after focused navigation.
The option terminator remains normal parser input. Removed the old root-help
flag inventory test: it demanded every leaf's flags on root help and duplicated
focused discovery coverage. Existing API operation/retry tests remain.

```sh
bun packages/cli/src/main.ts template --help
bun packages/cli/src/main.ts template -h
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/templates-api.test.ts
```

Offline discovery only, not staging/provider/TTY evidence. The help-only amendment
applies. No authenticated actions were performed. This completes the selected
template help navigation slice, not the entire #979 campaign.

## Coordinator checks

After deployment inspect both root help spellings in a pipe and unconfigured
named profile. Confirm the command map leads to focused leaf options and no login
is requested. No actual template write, launch or production check required.
Migration files: none. Deployment prerequisites: none.
