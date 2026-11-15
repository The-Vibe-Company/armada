# Routine state-change help (#979)

## Selected slice

Baseline enable/pause/delete help (both spellings) shows the entire schedule
creation page, without focused examples or clear action-specific boundaries.
Nested help also fails under an unconfigured named profile. Focus these three
pages through existing exact-boundary pre-auth help: version guards, next
occurrence versus immediate launch, and admitted runs versus new admissions.
No scheduling, mutation, parser, API, permission, JSON schema or capability change.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing run-boundary help table for the three leaves and both
spellings with profile selection and network/stdin forbidden. It fails on
baseline profile configuration, passes after focused help. Literal names,
malformed version flags and terminators stay normal parser input. The broad
schedule-help inventory leaves these pages to their focused primary owner;
existing API mutation/admitted-run tests remain.

```sh
bun packages/cli/src/main.ts routine enable --help
bun packages/cli/src/main.ts routine pause -h
bun packages/cli/src/main.ts routine delete --help
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/routines-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No authenticated routine mutation was performed. Create/update/family
help remain separate slices; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for each leaf, including pipes and an
unconfigured named profile. Confirm version conflict guidance and admitted-run
semantics are clear and no login is needed for help. No actual scheduling,
provider mutation or production check required.
Migration files: none. Deployment prerequisites: none.
