# GitHub forge plugin

Default-enabled `forge.github`. Config: `projects[projectId].repository` is
`owner/name`. The declared `GITHUB_TOKEN` is read through `ctx.secrets`, then
bounded `gh auth token` is the fallback. The plugin never opens a keychain.

`activate` registers without fetching. Reads paginate the open PR list every
time because check progress need not update a PR's timestamp. Previously open
PRs absent from the list are resolved individually, without a recent-closed
window. Branches link only to known tracker tickets in that project's events.
Checks are pinned to the head and select the latest workflow attempt; truncated
checks stay pending. Snapshots and transitions deduplicate against log history;
replay repairs transition tails interrupted between appends.

The daemon owns polling. Reads have bounded cancellation, reject partial
network responses, and never append late results. A timed-out wire read keeps
the single-read gate until it settles. Reflected credentials are redacted and
raw transport errors never escape.

`merge` uses the owner's REST endpoint with the requested head in `sha`, uses
squash merge, confirms GitHub's `merged` response, and returns GitHub's valid
squash SHA when present without changing the old result when it is absent. It
never retries a write. `inspect` reads a fresh pinned head/base, check and
review evidence, branch-protection checks and an exact REST base...head
comparison; truncated enumerations are explicitly incomplete. Optional
`endpoint` replaces the GraphQL base (the REST paths use the same origin) for
local conformance fixtures.

```sh
bun run armada plugin test packages/plugins/github
node --test packages/plugins/github/test/*.test.ts
```
