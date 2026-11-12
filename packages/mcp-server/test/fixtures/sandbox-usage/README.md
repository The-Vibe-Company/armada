# Usage stream provenance

## Coordinator production captures (2026-11-10)

- `boat-claude.json`, `boat-codex.json`: complete event arrays supplied by
  the coordinator from `armada logs <id> --all --json`, after one successful
  "Reply with exactly: OK" turn. These are Armada-normalized events, NOT raw
  Boat envelopes. Neither contains token usage.
- `modal-codex-usage.json`: exact queued prompt, custom usage and finished
  prompt frames extracted from the coordinator's complete Modal recording.
  Unrelated startup/item/text events are omitted. No usage fields were added.

These establish the production provider difference but do not prove what fields
a raw Boat response contained before normalization. Native Boat extraction is
follow-up #883; these fixtures assert unknown, not zero, until reported.

- `modal-claude-usage.json`: queued/running prompt, final `result` and
  finished prompt frames extracted from the coordinator's real production
  Modal × Claude recording on 2026-11-10. Golden: `native-linear-modal`;
  model: `claude-opus-5-5`; organization subscription; prompt:
  "Reply with the single word ok.". Source: `armada logs <id> --all --json`
  saved as `/tmp/modal-claude-recording.json` in the delivery sandbox.
  System init, messages, command lifecycle, paths, tools, session metadata,
  timing/cost diagnostics and unrelated result fields were omitted. Retained
  counter values are unchanged: input 2, output 4, cache creation 19047,
  cache read 0, thinking 0. No credentials or native auth payloads are included.
  The contemporaneous production status already showed input/output/cache read;
  this regression also protects the formerly absent cache-creation field.

## Modal stop/resume (#1246)

`modal-codex-resume.json` transcribes the coordinator's real Modal capture posted
on issue #1246 on 2026-11-12 at 18:41 UTC. Source:
https://github.com/The-Vibe-Company/armada/issues/1246 (coordinator capture comment).
The coordinator, not this worker, performed the production observation; this
worker made no production calls. Same Codex conversation, model gpt-6.1-sol,
launch/finish, confirmed stop, send/auto-resume/finish. The complete ordered
`other` event-type lane is preserved. Only the two accounting payloads were
provided; other event payloads, IDs, timestamps and text are deliberately absent.
Prompt IDs retain the short IDs in the posted status. At +20 seconds, status
had both rows: first 13212 input/5 output/0 cached/13209 cache-write; resumed row
all null, and old aggregate totals all null. The test verifies the corrected
known subtotal plus `incomplete: true`, including replay idempotence.

This public recording proves Modal's normalized unknown result, not the raw
`thread/tokenUsage/updated` timing. The latter is captured separately using the
pinned native app-server in `packages/agent-runtime/test/fixtures/`.
