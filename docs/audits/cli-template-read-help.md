# Template reader help (#979)

## Selected slice and baseline

Both `template list --help` and `template get --help` (also `-h`) print the
entire template family page, including write/launch options. It has no example
for either read command and does not explain how to obtain definitions versus
metadata. Under an unconfigured named profile, nested help can fail before
reaching that page. Selected fix: exact-boundary pre-authentication help for
these two readers, using the existing focused-help mechanism.

No API, operation parser, output schema, permissions or capability changes.
No other template leaf or family page is changed. Other findings remain separate
slices. This branch is independent from the previous launch/host help slices.

## Evidence and replay

The existing run-boundary help table now covers both readers and both spellings,
with profile selection and network/stdin forbidden. It fails on baseline because
nested help requires profile configuration, then passes with focused help.
Malformed invocations and literal argument handling remain with their parsers.

```sh
bun packages/cli/src/main.ts template list --help
bun packages/cli/src/main.ts template get -h
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/templates-api.test.ts
```

This is offline discovery evidence, not staging/provider/TTY evidence. The issue's
help-only amendment applies. No authenticated action was exercised for this audit.

## Coordinator checks

After deployment inspect both help spellings for each reader, including a pipe
and an unconfigured named profile. Confirm only reader options are shown and no
login is required. No provider mutation or production check is needed.
Migration files: none. Deployment prerequisites: none.
