# Template deletion help (#979)

## Selected slice

Baseline `template delete --help` and `-h` show the full template-family page,
including create/launch options, no deletion example and no explanation of the
required revision guard. With an unconfigured named profile, help can fail before
that page. Focus only exact-boundary deletion help through the existing
pre-authentication discovery mechanism. No API, permission, operation parser,
output schema or capability changes; no flag rename.

Reader help is already focused. Other template actions remain separate slices.
This branch starts from fresh main and is not stacked.

## Evidence and replay

The existing run-boundary help table now covers deletion and both spellings,
with profile selection and network/stdin forbidden. It fails on baseline profile
configuration, then passes after focused help. Literal target names, malformed
revision flags and the option terminator remain with their parsers. The broad
family write-help inventory no longer demands unrelated create/launch flags on
delete help; focused help has one primary test owner.

```sh
bun packages/cli/src/main.ts template delete --help
bun packages/cli/src/main.ts template delete -h
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/templates-api.test.ts
```

Offline evidence only, not provider/staging/TTY evidence. The ticket's help-only
amendment applies. No authenticated deletion was performed for this audit.

## Coordinator verification

After deployment inspect both help spellings, including a pipe and an
unconfigured named profile. Confirm revision-conflict guidance, example and no
login requirement. No template or sandbox deletion is needed to check this text.
Migration files: none. Deployment prerequisites: none. Production checks: none.
