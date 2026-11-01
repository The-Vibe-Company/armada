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

Active-ticket PRs also read REST review and PR discussion comments with a
five-second cursor overlap, single-page ETags and 304 responses. Paginated
GraphQL review threads supply resolution state (GitHub offers no thread
`since` filter); REST `in_reply_to_id` rebuilds reply chains. A pinned REST
base/head comparison detects behind branches even without strict protection.
Comments are capped at 600 characters; source IDs deduplicate replay and
interrupted writes. `armada.github-reader` v1 checkpoints persist each PR's
cursor, conditional reads, thread state and failure window only after its
observations have committed. A failed PR retains its cursor independently;
404 retries, 410 abandons immediately, and continuous failures abandon after
24 hours. Abandoned PR numbers appear in reader state.

Forge polling is 30 seconds with sessions in flight and five minutes idle;
a newly active session re-arms the idle timer. GitHub's `X-Poll-Interval`,
`Retry-After` and doubling rate-limit backoff survive restart and constrain
manual refreshes too. Readiness includes `forgeBackoffMs` and `forgeAbandoned`
when applicable. External comments go to the PR's current worker generation
through keyed `worker.message`; the PR author's own account is suppressed.
Conflict/behind candidates are exposed by `coordinator/forge-wake.ts` for the
Waker; comment/thread inputs do not create coordinator candidates.

Each PR has its own five-second deadline; requests that ignore cancellation
remain single-flight for that PR while healthy peers keep advancing. Current
failures are exposed as `forgeFailures` (PR, count, first failure, safe category),
and degrade forge readiness before the 24-hour abandonment threshold. Comment
source revisions are part of worker delivery identities, so edited comments
can be delivered without colliding with the original receipt.
