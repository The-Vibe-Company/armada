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
