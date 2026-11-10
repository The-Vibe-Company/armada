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
