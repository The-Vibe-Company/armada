# Routine reader help (#979)

## Selected slice

Baseline routine list/show/runs help (both spellings) prints the entire schedule
creation/update page, no focused examples and little distinction between
configuration, admission and task outcomes. Unconfigured named-profile nested
help can fail before the page. Focus just these three read pages through existing
exact-boundary pre-authentication help. No scheduling, mutation, API, permissions,
output schema or capability changes. This branch starts from fresh main, not stacked.

## Evidence and replay

Extended the existing run-boundary help table for all three readers and both
spellings, with profile selection and network/stdin forbidden. It fails on
baseline profile configuration and passes after focused help. Literal names,
malformed flags and terminators stay parser input. The broad schedule-help test
no longer requires write flags on read-help pages; focused discovery has one owner.

```sh
bun packages/cli/src/main.ts routine list --help
bun packages/cli/src/main.ts routine show -h
bun packages/cli/src/main.ts routine runs --help
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/routines-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. The ticket's help-only
amendment applies. No authenticated routine operation was performed. Mutation
and family help remain separate slices; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for all three readers, including pipes
and an unconfigured named profile. Confirm configuration versus run outcomes,
ID reuse and prompt sensitivity are clear. No scheduling or provider operation
is required. Migration files: none. Deployment prerequisites: none. Production
checks: none.
