# Root help alias with profiles (#979)

## Selected slice

Baseline already accepts `armada help` as root help, but an unconfigured named
profile rejects it with exit 2 and a login-configuration error. `--help` and `-h`
succeed in the same context. The profile discovery allowlist omitted the existing
word alias. Add only that exact single-argument alias to the allowlist and mention
it in root help. No new command forms, API, authentication, profile storage or
operation behavior changes. Independent branch from fresh main, not stacked.

## Evidence and replay

One run-boundary regression covers all three aliases under explicit --profile
and ARMADA_PROFILE selection, with network/stdin forbidden. It fails on baseline
exit 2 for help, then passes after the one-line discovery correction. Existing
root command/unknown command/profile tests retain their ownership.

```sh
bun packages/cli/src/main.ts --profile new-user help
ARMADA_PROFILE=new-user bun packages/cli/src/main.ts help
bun test packages/cli/test/run.test.ts scripts/armada-skill.test.ts
```

Offline evidence only, not staging/provider/TTY evidence. This is pure client
help discovery, covered by the ticket amendment. No authenticated operation was
performed. No whole-ticket completion claimed.

## Coordinator checks

After deployment inspect help/--help/-h with an unconfigured profile, selected
both explicitly and through ARMADA_PROFILE, including pipes. All should return
root help without requesting login. No provider mutation or production check is
required. Migration files: none. Deployment prerequisites: none.
