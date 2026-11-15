# Local Docker-host help (#979)

## Selected slice

Baseline local host install/status/uninstall help (both spellings) returns the
same two-line installation usage, no focused examples and little distinction
between local daemon operations and authenticated host metadata. Add focused
text inside the existing local-command help boundary. No native execution,
installation, token, authentication, API, output schema or lifecycle changes.
Independent branch from fresh main, not stacked.

## Evidence and replay

One run-boundary test covers all three leaves and both spellings with a named
profile and all native/account property access forbidden. It fails on baseline
missing example and passes after focused help. Existing native lifecycle tests
retain operation coverage; no production test seam added.

```sh
bun packages/cli/src/main.ts host install --help
bun packages/cli/src/main.ts host status -h
bun packages/cli/src/main.ts host uninstall --help
bun test scripts/armada-skill.test.ts packages/cli/test/local-host.test.ts packages/cli/test/host-commands.test.ts
```

Offline evidence only, not host installation/staging/TTY evidence. Help-only
amendment applies. No native operation, token exchange or provider call was made
for this audit. No whole-ticket completion claimed.

## Coordinator checks

After deployment inspect both help spellings for all three leaves in pipes and
with a named profile. Confirm local-machine placement, stdin-only installer token,
status JSON and uninstall reconciliation are clear. No installation/uninstallation,
real token or production check is needed.
Migration files: none. Deployment prerequisites: none.
