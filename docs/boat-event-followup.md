# Boat cursor follow-up completion (#1161)

## Confirmed code defect

Native Boat receipts return `response.promptId` unchanged
(`provider-boat/src/provider.ts:prompt`). Event normalization assigns the same
vendor `taskId` to `promptId` (`events.ts:normalizeEvent`); there is no server-side
ID substitution. The SDK's own `streamPrompt` makes that same comparison.

Unlike the append-only Armada runtime journal, Boat updates prompt and streaming
response rows **in place**. This is already documented by `core/src/outcome.ts`: terminal truth must
come from `getPrompt`, not an assumption that prompt events are append-only.
The old event adapter nevertheless advanced its timestamp/id cursor past a
running prompt row. If the row later changed to finished at the same boundary,
forward reads could return the answer but never its terminal prompt event.
`logs --all` starts over and sees the finished row; cursor polling can wait forever.
The parity observer correctly requires both the matching answer and completion;
no timeout relaxation or smoke-only fallback fixes that server contract.

The offline HTTP-boundary regression obtains a real adapter send receipt, reads
the running and partial events, updates both fake vendor rows without changing
their timestamp/ID, and appends a newer event. Old code misses completion; fixed code returns that same
prompt ID's finished row and final answer, even with count/byte page budgets.
This proves the mutable-row defect; production acceptance remains the coordinator's
rerun, not a claim that offline reproduction inspected production payloads.

## Fix

Forward opaque cursors retain the physical frontier plus unfinished prompt/partial
response row boundaries and snapshot fingerprints. Subsequent reads re-read those
exact rows and emit their
actual changed vendor snapshots before proceeding through newer events. No
completion is synthesized, no timestamp changed, and no receipt rewritten.
Each emitted entry carries its own continuation so count/byte page bounds cannot
acknowledge an undelivered completion or skip an answer. Terminal/nonpartial rows
leave the continuation. Cursors contain IDs/boundaries and SHA256 fingerprints
only, never prompt text,
model credentials or tokens. Replayed snapshots pass normal server redaction.
Native legacy cursors remain accepted; an already-passed unfinished row cannot be
recovered from an old timestamp-only cursor, so reload the log from no cursor
when testing an existing session after rollout. Backward history remains native.
Malformed or oversized continuations fail explicitly rather than silently dropping
pending completions. No database migration, runtime artifact change, native
fallback or default switch is involved. Only the Boat adapter changes.

## Dashboard impact

Yes: `sandbox-chat.tsx` keeps a cursor across polls and merges events by ID.
Its events API calls `readLogPages` → gateway `logs` → the same Boat
`provider.events` implementation as `logs/read`. Its follow-up send uses gateway
`send`, also the same server path. The defect can leave the visible prompt state
stale even when status metadata or an answer arrives; the fix delivers the updated
row on that shared lane. No dashboard-specific protocol or UI edit is needed.

## Coordinator acceptance (no worker production access)

After normal server delivery, reuse the existing production Boat parity inputs
and your own authorized sandboxes. No setting changes or new secrets:

```sh
bun scripts/post-deploy-smoke.ts --parity --only boat --production-boat
```

Require both initial and follow-up `send` steps to complete: the returned receipt
prompt ID must occur on the archived/read answer and finished prompt event; cursor
pages must drain to the newest events rather than repeat the first page. No retry
or second allocation to guess an ambiguous outcome. Then open that sandbox's
conversation in the dashboard, send one follow-up, and verify its answer and
finished state update without a browser reload. Reuse the normal lifecycle cleanup.
A `logs --all` dump alone is not cursor-stream acceptance. No live run/deploy was
performed by this worker; do not infer model elapsed time from a mutable row's
unchanged timestamp.
