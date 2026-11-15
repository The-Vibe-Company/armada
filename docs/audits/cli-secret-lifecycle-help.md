# Application-secret lifecycle help (#979)

## Selected slice

Baseline rotate/revoke/delete help (both spellings) shows the combined vault page
without focused examples, obscuring value replacement versus terminal revocation
and deletion for name reuse. Named-profile nested help can fail before that page.
Focus these three exact-boundary pre-auth pages with ID/version guards and safe
input/output guidance. No value handling, lifecycle, parser, API, permission,
output schema or capability changes. Broader existing help recognition is
unchanged. Independent branch from fresh main, not stacked.

## Evidence and replay

Extended existing run-boundary help coverage for all three leaves and spellings,
with profile selection and network/stdin forbidden. It fails on baseline profile
configuration and passes after focused help. File/version values and terminators
stay parser input. Broad vault-help coverage now tests families only; focused
leaves have one primary owner. Existing value/security/API tests remain.

```sh
bun packages/cli/src/main.ts secrets rotate --help
bun packages/cli/src/main.ts secrets revoke -h
bun packages/cli/src/main.ts secrets delete --help
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/application-vault-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No real secrets read, rotated, revoked or deleted. Family navigation
remains a separate slice; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for all three leaves in pipes and an
unconfigured named profile. Confirm ID/version guards, write-only replacement
input, revocation terminality, name reuse and metadata-only output are clear.
No real secret mutation, provider operation or production checks needed.
Migration files: none. Deployment prerequisites: none.
