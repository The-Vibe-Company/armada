# Application-vault set help (#979)

## Selected slice

Baseline vars set/secrets set help (both spellings) prints the combined vault
page without focused examples, obscuring create-not-update semantics, explicit
organization/scope rules and value sensitivity. Nested help can fail on an
unconfigured named profile before that page. Focus exact set-help forms through
the existing pre-authentication mechanism. No value handling, parser, API,
permission, JSON schema or capability changes; broader existing help recognition
stays unchanged. Independent branch from fresh main, not stacked.

## Evidence and replay

Extended existing run-boundary help coverage for both leaves and spellings with
profile selection and network/stdin forbidden. It fails on baseline profile
configuration and passes after focused help. File/scope values and terminators
stay parser input. Broad vault-help inventory leaves read/set pages to focused
coverage; existing value-byte, UTF-8, scope and metadata-only API tests remain.

```sh
bun packages/cli/src/main.ts vars set --help
bun packages/cli/src/main.ts secrets set -h
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/application-vault-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No real values were read or written. Rotation/revocation/family help
remain separate slices; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for both leaves in pipes and an
unconfigured named profile. Confirm input-only-from-stdin/file, create-not-update,
scope rules and variable-versus-secret distinctions. No real value reads/writes,
provider mutation or production checks needed.
Migration files: none. Deployment prerequisites: none.
