# Linear tracker plugin

Default-enabled `tracker.linear`. Config: `projects[projectId]` holds
`programRoot`, optional `phaseGroup` (default `Agent phase`), `runtimeGroup`
(default `Agent runtime`) and `readyLabel` (default `ready-for-agent`). The
declared secret is `LINEAR_API_KEY`; all access goes through `ctx.secrets`.

`activate` registers the provider without fetching. `read` ingests a complete
or incremental program tree, labels, attachments and comments through
`ctx.events`. Completed reads retain the start watermark with one-second
overlap; a full read every 30 minutes catches tickets leaving scope. Reports,
phase changes and questions deduplicate against history, including on restart.
The daemon owns the polling cadence; the reader's deadline and single-read gate
prevent overlapping or late observations. Errors never include response bodies
or credentials.

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
