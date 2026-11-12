# Codex resumed usage (#1163)

A native `thread/tokenUsage/updated` snapshot observed during resume/initialization
can establish the first resumed baseline, but only after the resume response
verifies the exact thread and before `turn/start` dispatch. Required counters and
cache/reasoning subset consistency are validated. Missing optional counters stay
unknown; no zero or historical snapshot is invented. A foreign thread, invalid
snapshot or post-dispatch update is never adopted as a pre-turn baseline.
Non-monotone pre-start observations invalidate this resume's candidate; replaying
a previous value cannot restore it. A later separate native handshake can still
establish a new baseline. This
is opportunistic: the protocol documents usage updates, not a guarantee that
all pinned/native versions emit a pre-turn snapshot on resume. No extra RPC,
transcript scan or inference is used to force one. The original baseline stays
fixed across steering. Dispatch invalidates the shared cache until fresh native
usage is observed; a missing terminal boundary clears that cache and leaves the
prompt's counters unknown, so process loss cannot seed a false next-turn delta.

## Coordinator staging check: Codex resumed baseline (#1163)

After normal runtime rollout on a Modal golden, launch and send again:

```sh
armada launch <modal-golden> --provider modal --agent codex "Reply OK"
armada wait <id>
armada send <id> "Reply OK again"
armada wait <id>
armada status <id> --json
```

Stop/resume the sandbox and send another prompt. If the native peer reports a
valid cumulative usage snapshot before turn dispatch, the first resumed prompt
may now show a measured delta rather than null. Expect the delta, never the
full historical total; all prompts are still priced separately by the future
server pricing integration. If the native version does not emit such a snapshot,
first-turn counts remain unknown. Do not interpret absence as zero. Native
baseline availability on real staging is a coordinator verification item, not
claimed by the worker or guaranteed by this slice.

Steer an active turn and verify only one final usage row includes both native
segments without resetting the baseline. Normal interrupt/failure terminal
snapshots retain measured counts. Process loss without a matching native terminal
leaves counters unknown and cannot seed a later prompt's baseline. Exact
before/after-reply/dispatch races, missing optional buckets, invalid/foreign
snapshots, cached-state invalidation and process loss are covered by the offline
real JSONL-driver tests; do not inject malformed data or kill staging compute to
force these cases. No migration, transport change, provider API call or transcript
copy. Source contract: pinned native types and the
[official app-server protocol](https://developers.openai.com/codex/app-server/).

## Resume smoke contract (#1246)

The [coordinator capture on #1246](https://github.com/The-Vibe-Company/armada/issues/1246)
records a real Modal Codex stop/resume/send at 18:41 UTC on 2026-11-12, using
`native-linear-modal` and gpt-6.1-sol. The same conversation finished its first
prompt, stopped, then auto-resumed on send and finished the second prompt.
The first runtime `armada/turnUsage` reported 13212 input, 5 output, 0 cached,
13209 cache-write and 0 reasoning tokens. The exact resumed prompt `b2c27dd7`
had an explicit all-null runtime usage snapshot. Status still showed both rows
20 seconds later; this is unknown accounting, not a missing server write or a
polling-budget problem. The public event sequence and accounting payloads are
preserved in `packages/mcp-server/test/fixtures/sandbox-usage/modal-codex-resume.json`.
The worker made no production calls; the evidence was supplied by the coordinator.

The raw token notifications are not forwarded to public logs. A separate real
pinned 0.167.0 local app-server capture reproduces the baseline timing:
`thread/resume` replies without a usage snapshot; only after `turn/start`
dispatch does the old total arrive, followed by the new cumulative total.
See `packages/agent-runtime/test/fixtures/codex-resume-recorded.json` and its
JSONL driver replay. The local trace is not relabeled as Modal wire evidence.
A post-dispatch old total cannot safely establish a pre-turn baseline; we do
not infer deltas from it or sum last-request counters. The supported contract
for this first cold-resumed turn remains explicit unknown, never cumulative
historical counts or zero. The driver regression publishes exactly one snapshot.

Previously, one unknown turn also erased known session totals. Public
`usage.tokenTotals` now sums known per-field values and reports `incomplete`
when any turn/field is missing, invalid or unknown. A field with no measured
values remains null (a confirmed empty session is zero). Per-turn unknowns
stay null; these subtotals are not complete session usage or pricing inputs.
Conservative internal summaries/child aggregation and cost calculation are
unchanged. No migration or historical backfill is needed: totals are derived
on read from the retained observations.

The Modal Codex `resume_usage` smoke now requires either measured counters or
an explicit all-null input/output/cache row for that exact resumed prompt,
plus numeric retained input/output subtotals and `incomplete: true` in the
unknown case. Missing rows, stale rows, incomplete unknowns and erased totals
still fail. Fresh turns still require measured counts. The merge-queue
tolerance for this step can be removed once the updated smoke runs. The supplied
Modal observation establishes the contract; running the changed smoke against
a deployed server remains a coordinator rollout check, not a deployment by this
worker. No runtime inference, pricing, provider transport or migration changes.
