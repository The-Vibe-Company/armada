# Linear tracker plugin

Default-enabled `tracker.linear`. Config: `projects[projectId]` holds
`programRoot`, optional `phaseGroup` (default `Agent phase`), `runtimeGroup`
(default `Agent runtime`) and `readyLabel` (default `ready-for-agent`). The
declared secret is `LINEAR_API_KEY`; all access goes through `ctx.secrets`.

`activate` registers the provider without fetching. `read` ingests a complete
or incremental program tree, labels, attachments and comments through
`ctx.events`. Completed reads retain the start watermark with one-second
overlap. A full read every six hours catches tickets leaving scope. The
`armada.linear-reader` checkpoints persist the last entity `updatedAt`, the
read-start watermark, known issue UUIDs and prior issue/comment state as deltas;
restarting with a fresh cursor resumes incrementally, without fetching the root.
Only a successful, complete read advances it. A missing cursor, a cursor older
than six hours, or six hours since the last full read requires reconciliation.
Reports, phase changes and questions deduplicate against history.

The daemon polls trackers every three minutes when idle, or every 30 seconds
while a worker is in flight or an owner has the room visible. Optional protocol
minor 14 room presence follows window visibility and disconnects; subscribing
to all projects does not count as looking at a room. Forge cadence is unchanged.
Coordinator refreshes still request fresh facts, but cannot bypass a cooldown.
The reader's deadline and single-read gate prevent overlapping or late observations.

HTTP 429, `Retry-After` (seconds or HTTP date), and GraphQL `RATELIMITED` pause
projects sharing the same credential and endpoint. The delay is capped at one hour;
without a valid announcement, numeric reset headers or a one-hour fallback apply.
One-way credential identifiers scope restored usage and cooldowns; credential values never enter the log.
Pause state survives restart and never advances the successful read timestamp.
The room header says when Linear will resume instead of silently showing old facts.

Issue and comment deltas share a request per 200 known IDs, with independent
pagination. Nested labels, attachments and relations are read only for changed
or new issues, with smaller first pages and complete pagination. External blocker
states are refreshed through batched aliases without re-reading unchanged issue details.
Each outgoing reader request, including pages and failures, increments the project's
UTC-hour counter. Numeric `X-Complexity` and `X-RateLimit-*` values appear in safe
daemon logs and reader checkpoints; About sums the projects' current-hour counts.
The counter covers tracker reads, not connection verification or writes. An idle
project of up to 200 known issues with no external blockers ordinarily costs one
request per three-minute delta read, plus full reconciliations. Errors never
include response bodies or credentials.

`write` resolves the issue and its applicable phase label (team first, then
workspace), preserves all other labels, and confirms each mutation before
posting a requested comment. A truncated label reading is refused rather than
overwriting unseen labels. Completed writes resolve the team's completed state,
remove the phase/runtime/ready labels, and use a stable comment id when one is
provided so an interrupted cleanup can replay safely. Truncated state or
comment readings are refused. Writes are not retried automatically.

Optional `endpoint` replaces the GraphQL endpoint for private deployments and
local conformance fixtures. `armada-plugin.test.json` routes the real adapter
to native recorded GraphQL responses. Run:

```sh
bun run armada plugin test packages/plugins/linear
node --test packages/plugins/linear/test/*.test.ts
```
