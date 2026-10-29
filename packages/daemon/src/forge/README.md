# GitHub forge reader

Node-only, in-process adapter for the owner's GitHub identity. `GithubForge`
implements `Forge.read(previousOpen, signal)`; it has no store, server, V1,
GitHub App or webhook dependency. The folder's sole daemon import is the public
`@armada/daemon/events` type vocabulary. Keep this folder intact when extracting
the GitHub plugin; providers are loaded at boot, with no hot reload.

The daemon boot owner supplies the event log, project, owner and current known
tracker IDs, and starts ingestion independently of request handling:

```ts
import { GithubReader } from "./forge/github.ts";

const github = new GithubReader({
  project: "boats",
  repository: "acme/boats",
  actor: "owner",
  store,
  tickets: () => knownTicketIds,
});
const stopGithub = github.start(); // returns immediately
// Before closing the event log on shutdown:
stopGithub();
```

`refresh()` also supports explicit refreshes; concurrent callers share one
reading. `stop()` cancels the next poll, aborts an active read and prevents late
writes. A complete reading has a 15-second deadline (token lookup, requests and
body), with an AbortSignal and an independent timeout race; polls wait 30 seconds
after completion. `now`, `schedule`, `fetch`, `token`, and the `Forge` itself are
injectable. The server should serve the local log/fold and never wait on GitHub.
This ticket supplies the adapter, not the daemon boot/server wiring.

The token accessor tries macOS Keychain service `armada.github`, account
`github`, then `gh auth token`; other platforms use `gh`. Child processes have a
five-second timeout and bounded output. Tokens stay in memory/request headers.
Raw provider, GraphQL and child-process errors never cross the adapter boundary;
returned facts redact any reflected credential. No token belongs in recordings.
An unavailable token or failed read returns a sanitized failure and leaves
prior observations intact; a later poll retries normally.

Open PRs are paginated every poll because check progress need not change PR
`updatedAt`. Previously open PRs absent from that reading are queried by number,
so merges/closures have no fixed recent-history window. The reader recovers
prior observations from the project event stream, then follows its sequence
cursor. It emits changed `pull-request.seen` snapshots for the existing fold,
plus `opened`, `head-moved`, `checks-green`, `checks-red`, `review-changed`,
`closed` and `merged` transition kinds. Every transition carries the observed
head and facts. An unchanged reading produces no new observation. Snapshots also record durable
intent for their deterministic transitions: replay repairs an interrupted append
tail with the original observation time and actor, without duplicating committed
facts. This requires no store transaction API. First observation of a
green/red PR emits its initial check fact; later head changes re-emit it for the
new head. Pending checks and changes to individual checks are snapshots.
Already closed PRs before first startup are not imported.

Branch IDs link only to known tracker tickets; unrelated PRs carry an empty
ticket ID. Checks are pinned to the PR head, select the latest workflow run and
attempt, and retain queued replacements/cancellations. Truncated checks/suites
stay pending unless failure is already known. GraphQL partial errors, malformed
pages and a missing previously open PR reject the whole network reading; a
missing PR never implies a merge. No partial network reading is persisted.

Tests use invented inline GraphQL recordings, generated ephemeral credentials,
real disposable event stores and a manual scheduler. Run from the repository:

```sh
node --test packages/daemon/test/github.test.ts packages/daemon/test/keychain.test.ts
bun run test:daemon
```
