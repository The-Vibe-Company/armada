# Profile discovery guidance (#979)

## Selected slice

Baseline root help only says profiles isolate login/preferences, without
explaining selector precedence, valid names, default-profile fallback or the
important limit that ARMADA_TOKEN still overrides saved login in every profile.
Expand that existing guidance and the onboarding profile section. No selector,
authentication, session-storage, API, permission or operation behavior changes.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing root-help run-boundary test with the precedence and token
isolation warnings; fails on baseline missing guidance, passes after the text
change. Existing profile tests retain isolation, override and origin-binding
coverage. No duplicate behavioral test or production seam added.

```sh
bun packages/cli/src/main.ts --help
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts scripts/armada-skill.test.ts
```

Offline discovery evidence only, not sign-in/staging/TTY evidence. Help-only
amendment applies. No authenticated operation was performed for this audit.
No whole-ticket completion claimed.

## Coordinator checks

After deployment inspect root help in a pipe and review the onboarding examples.
Confirm selector precedence, default fallback, name syntax and environment-token
limits are clear. No login, token exchange, provider mutation or production check
is needed. Migration files: none. Deployment prerequisites: none.
