# Bare resource-family discovery (#979)

## Selected slice

Bare template/routine/vars/secrets already return help with exit 0, but named
profile configuration can block those no-operation invocations. They also use
legacy dense help despite focused indexes now existing. Extend the existing
exact bare-family discovery path to these four families; preserve their exit 0
and existing snapshot/host missing-subcommand exit 2. No operation, parser, value,
scheduling, API, permission, authentication or capability changes.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extend the existing bare-family run-boundary table, not a duplicate test. All
families use an unconfigured explicit profile with account/network/stdin access
forbidden. Baseline fails account access on template; candidate emits each
existing focused index, empty stderr and original exit codes. Operations/flags
and terminators remain outside this exact single-command branch.

```sh
bun packages/cli/src/main.ts --profile new-user template
bun packages/cli/src/main.ts --profile new-user routine
bun packages/cli/src/main.ts --profile new-user vars
bun packages/cli/src/main.ts --profile new-user secrets
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts packages/cli/test/templates-api.test.ts packages/cli/test/routines-api.test.ts packages/cli/test/application-vault-api.test.ts scripts/armada-skill.test.ts
```

Offline client evidence only, not staging/provider/TTY evidence. Pure client
amendment applies. No authenticated/native/value operation performed. No
whole-ticket completion claimed.

## Coordinator checks

After deployment run all four bare families under an unconfigured named profile,
including pipes. Confirm focused indexes, exit 0, empty stderr and no login prompt.
Snapshot/host bare usage should still exit 2. No value reads/writes, scheduling,
provider mutation or production check required.
Migration files: none. Deployment prerequisites: none.
