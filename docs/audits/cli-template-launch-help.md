# Template launch help (#979)

## Selected slice

Baseline `template launch --help` / `-h` show the entire family page, including
create/publish flags rather than a focused launch example. Nested help can also
fail before that page under an unconfigured named profile. Selected fix: focused
exact-boundary pre-authentication help, with options and request-key recovery.
No operation parser, API, permission, JSON schema or capability changes.
No flag rename. This independent slice starts from fresh main; not stacked.

## Evidence and replay

The existing run-boundary help table now covers launch and both spellings with
profile selection and network/stdin forbidden. It fails on baseline profile
configuration and passes after the focused page. Literal prompt/target values,
malformed flags and terminators remain with normal parsing. The family help
inventory no longer demands create/publish flags on launch help; focused help
has one primary test owner. Existing template API tests retain launch/retry
contracts.

```sh
bun packages/cli/src/main.ts template launch --help
bun packages/cli/src/main.ts template launch -h
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/templates-api.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. The ticket's help-only
amendment applies. No authenticated launch was performed for this audit.
Remaining template family/definition help remains a separate slice.

## Coordinator verification

After deployment inspect both spellings in a pipe and unconfigured named
profile. Confirm request-key preservation and resolved-ID recovery are clear,
and no login is required for help. No actual launch or production check needed.
Migration files: none. Deployment prerequisites: none.
