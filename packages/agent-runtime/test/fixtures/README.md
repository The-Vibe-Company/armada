# Fixture provenance

- `codex-terminal-recorded.json`: terminal failure recorded from pinned Codex
  0.167.0 app-server in the opt-in local Boat smoke on 2026-11-08. Identities
  replaced; provider message omitted; only failed status and typed
  `httpConnectionFailed` retained (HTTP status unavailable). This proves failure
  handling, not successful model parity. Subsequent real API-key-login smoke
  passed remember/resume/recall.
- `app-server.ts`: synthetic JSONL peer using pinned generated official types.
  It replays that recorded failure or tests deterministic request/notification
  ordering, including interrupt-before-restart steering. Synthetic terminal
  success is not model evidence.
- `claude-process.ts`: synthetic CLI-side peer using official SDK control and
  message shapes. The real pinned Claude SDK manages the child process. It
  tests initialization, streaming input, merged-result UUID correlation,
  partials, interruption and independent query cleanup; no authenticated
  Claude conformance is claimed.
- `codex-resume-recorded.json`: sanitized accounting-only sequence from a real
  API-key authenticated Codex 0.167.0 app-server on this development sandbox,
  2026-11-12. Fresh prompt, process restart, `thread/resume`, second prompt.
  Dispatch markers are capture-client observations. All text, paths and real
  identities omitted; counters unchanged. The historical total is notified only
  after resumed `turn/start` dispatch, followed by the new cumulative total.
  `recorded-resume.ts` replays that resume segment at the JSONL driver boundary.
  This is native evidence, **not a Modal capture**; the staging run below only
  exposes smoke receipts, not native JSONL.
