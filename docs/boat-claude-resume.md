# Boat Claude resume investigation (#785)

## Observed on the development Boat sandbox, 2026-11-10

The installed Claude Code is 2.1.322. A real `claude -p` invocation from
`/home/user/claude-offline-probe` wrote
`~/.claude/projects/-home-user-claude-offline-probe/<session-id>.jsonl`.
Records contain both `cwd` and `sessionId`. These files are harness state, not
Boat's conversation-list metadata or Armada's event mirror.

Using the installed CLI against a local, deterministic Anthropic SSE stub:

- A first prompt containing a probe word created a session.
- A new process with `--resume <session-id>` sent the previous messages,
  including the word, and retained the session ID.
- `--continue` in the original directory selected that same session.
- `--continue` in another directory created a different session without the word.
- In this installed version, an explicit `--resume <session-id>` from another
  directory also found the original session and replayed the word. Do not assume
  explicit-ID lookup is always restricted to the current project directory.

The stub did not perform inference: replay was checked in the actual outbound
message history, not by trusting its fixed `OK` response. Both unauthenticated
live Claude inference and `boat prompt self` failed authentication. This is
process/session-storage evidence, **not** a live Boat stop/restart smoke test.
No production resources were accessed or stopped.

Codex differs: Armada's native runtime uses its app-server `thread/resume`
protocol with a thread ID and cwd (`packages/agent-runtime/src/codex.ts`), rather
than Claude's project transcript selection. Boat's ordinary conversation ID is
provider-owned metadata for either harness; its presence is not a native
checkpoint acknowledgement.

## Repair and limits

Boat best-effort activation must not treat a missing conversation-list entry as
an inability to restart the machine. Likewise a model alias reported by Boat
is not evidence of lost session files. Resume retains the conversation when
metadata identifies the same harness; otherwise it resets only the active
conversation pointer, preserving mirrored history, and publishes a ready,
unverified parent with the closed note `previous_conversation_not_continued`.
The next user message starts the fresh conversation; resume sends no synthetic
prompt. Provider/auth/activation failures are not silently converted to success.

Credentials and transcript persistence are separate concerns. Launch sends the
resolved environment through Boat's sandbox creation API; resume revalidates the
pinned credential binding. No OAuth token is copied into transcripts, goldens,
or a new credential file by this repair. Live credential persistence across
Boat archival remains dependent on Boat's sandbox environment restore contract.

For a live follow-up smoke with authorized test credentials: create a Boat Claude
parent, send a unique word, stop, resume, and ask for the word. Check the operation
receipt and events; distinguish continued history from the explicit fresh-session
note. Repeat with Codex to protect its existing best-effort behavior.
