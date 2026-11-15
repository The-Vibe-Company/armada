# Template definition help (#979)

## Selected slice

Baseline `template create` and `template publish` help (both spellings) show the
entire family page, with unrelated launch/delete options and no focused example.
With an unconfigured named profile, nested help can fail before reaching that
page. Focus these two definition-writing help pages, sharing their common input
options while explaining create scope versus publish revision requirements.
No operation parser, API, permission, JSON schema, capability or flag changes.
This independent branch starts from fresh main; not stacked.

## Evidence and replay

Existing run-boundary help coverage now includes both leaves and both spellings
with profile selection and network/stdin forbidden. It fails on baseline profile
configuration and passes after focused help. Literal names, malformed file flags
and terminators stay with normal parsing. The family help inventory now covers
only family help, leaving all leaves to their focused primary test owner.

```sh
bun packages/cli/src/main.ts template create --help
bun packages/cli/src/main.ts template publish -h
bun test packages/cli/test/onboarding-help.test.ts packages/cli/test/templates-api.test.ts
```

Offline discovery only, not staging/provider/TTY evidence. The help-only amendment
applies. No authenticated writes were performed. Family navigation remains a
separate possible slice; no whole-ticket completion is claimed.

## Coordinator checks

After deployment inspect both leaves and both help spellings in a pipe and an
unconfigured named profile. Confirm create scope versus publish revision rules,
file/flag exclusivity and reference-only secret input are clear. No actual
publication, launch or production check is required.
Migration files: none. Deployment prerequisites: none.
