# Application-vault reader help (#979)

## Selected slice

Baseline vars list/read and secrets list help (both spellings) shows one combined
write/rotate/read page, no focused examples, and obscures metadata versus value
output. Nested help can fail on unconfigured named-profile selection first.
Focus these three exact-boundary pre-auth help pages. Clarify ID-only variable
reads, exact value stdout, JSON envelopes and metadata-only secret listing.
No value handling, operation parser, API, permission, output schema or capability
changes. Existing broader help recognition remains unchanged. Independent branch
from fresh main, not stacked.

## Evidence and replay

Extended existing run-boundary help table for all three leaves and both spellings
with profile selection and network/stdin forbidden. It fails on baseline profile
configuration and passes after focused help. Malformed option values and terminators
remain parser input. Broad vault-help inventory leaves these readers to focused
coverage; existing value/metadata/security API tests remain.

```sh
bun packages/cli/src/main.ts vars list --help
bun packages/cli/src/main.ts vars read -h
bun packages/cli/src/main.ts secrets list --help
bun test scripts/armada-skill.test.ts packages/cli/test/onboarding-help.test.ts packages/cli/test/application-vault-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. Help-only amendment
applies. No authenticated values were read or written. Write/family help remains
separate slices; no whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both spellings for each leaf in pipes and an unconfigured
named profile. Confirm metadata/value distinctions, ID-only reads, newline behavior
and no secret-read capability are clear. No real secret or value reads/writes,
provider mutation or production checks required.
Migration files: none. Deployment prerequisites: none.
