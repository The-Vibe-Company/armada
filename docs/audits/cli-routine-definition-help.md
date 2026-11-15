# Routine create/update help (#979)

## Selected slice

Baseline create/update help (both spellings) shows the full scheduling-family
page, no focused examples, and obscures file replacement versus inline schedule
update semantics. Named-profile nested help can fail before that page. Focus
these two pages via existing exact-boundary pre-auth help. Clarify complete
update JSON requirements, create defaults, scope, prompt input and version guards.
No scheduling, mutation, parser, API, permissions, output schema or capability
changes. Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing run-boundary help table for both leaves and spellings with
profile selection and network/stdin forbidden. It fails on baseline profile
configuration, passes after focused help. Literal names, prompt-file values and
terminators stay parser input. The broad schedule-help inventory now covers only
the family page; focused leaves have one primary owner. API tests retain complete
replacement/inline update conflict coverage.

```sh
bun packages/cli/src/main.ts routine create --help
bun packages/cli/src/main.ts routine update -h
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/routines-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No authenticated routine writes performed. Family navigation remains a
separate slice; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for each leaf in pipes and an
unconfigured named profile. Confirm create defaults versus complete update JSON,
inline schedule retention and version conflicts are clear. No actual scheduling,
provider mutation or production check needed.
Migration files: none. Deployment prerequisites: none.
