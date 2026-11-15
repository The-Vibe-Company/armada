# Launch help (#979)

## Slice and offline audit

At baseline main, both `armada launch --help` and `armada launch -h`
succeed but print the entire root command tree, mixing snapshot building,
account setup and sandbox operations with launch options. This is the selected
discovery friction; other root-help fallbacks remain separate slices.

The candidate supplies focused help for existing Boat/Modal snapshot launches
and Docker host/snapshot launches, examples, organization/authentication guidance,
sizing precedence, connection defaults and uncertain-outcome recovery.
No operation parser, API request, output schema or capability changes.

Replay locally without a session (no provider or staging requests):

```sh
bun packages/cli/src/main.ts launch --help
bun packages/cli/src/main.ts launch -h
bun test packages/cli/test/onboarding-help.test.ts
```

Both help spellings must return zero and describe only launch. The run-boundary
test forbids network and stdin access, exercises profile selection, and retains
literal/malformed argument handling. This extends the existing primary test,
rather than adding a duplicate help inventory.

## Limits and coordinator checks

This is offline discovery evidence, not staging, human sign-in or interactive
TTY evidence. The issue's help-only amendment applies. No deployment prerequisite,
migration or production verification is required for this text-only slice.
After deployment, the coordinator can inspect both help spellings in a terminal
and pipe, confirm readable output and replay one documented launch example
against an authorized staging fixture if desired. No Boat release-gate probe.
The broader #979 quality campaign remains open work beyond this slice.
