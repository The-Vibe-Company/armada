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
