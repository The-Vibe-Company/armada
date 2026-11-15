# Bare host usage (#979)

## Selected slice

Bare snapshot usage was fixed separately. Baseline bare host still enters
account/profile/organization preparation before reporting a missing subcommand;
with no selected org it falls back to compressed legacy usage rather than the
focused host index. Extend the existing exact bare-family discovery path to host.
Keep missing-subcommand exit 2 and explicit-help exit 0. Native local operations,
authenticated host commands, APIs, permissions and capabilities are unchanged.
Independent branch from fresh main, not stacked.

## Evidence and replay

Extended the existing bare-family run-boundary test with host, preserving
snapshot aliases: unconfigured explicit profile, account/network/stdin forbidden.
Baseline fails account access for host; candidate emits the existing host index,
exit 2, empty stderr and no root quick-start dump. No duplicated owner or seam.

```sh
bun packages/cli/src/main.ts --profile new-user host
bun test packages/cli/test/run.test.ts packages/cli/test/profiles.test.ts packages/cli/test/host-commands.test.ts packages/cli/test/local-host.test.ts scripts/armada-skill.test.ts
```

The bare probe intentionally exits 2. Use host --help for successful explicit
discovery. No args, flags or payloads are rewritten.

Offline client evidence only, not staging/provider/TTY evidence. Pure client
amendment applies. No authenticated/native operation performed. No whole-ticket
completion claimed.

## Coordinator checks

After deployment run bare host under an unconfigured profile and with selected
org, including pipes. Confirm focused local/account command index, exit 2, empty
stderr and no login prompt; explicit help still exits 0. No native operation,
provider mutation or production check required.
Migration files: none. Deployment prerequisites: none.
