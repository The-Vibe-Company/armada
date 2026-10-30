# Codex runtime

Bundled `runtime.codex`, Plugin API 0.2. The host binds the selected node with
`withNode`; preparation and all process writes stay on that node, under its
worker-generation guards. No registry or other plugin is imported.

Configuration under `runtime.codex`:

```json
{
  "model": "gpt-6.1-sol",
  "effort": "high",
  "extraArgs": [],
  "command": "codex"
}
```

All fields are optional. Host routing (`--model`, `--effort`) overrides the
configured model/effort. Codex receives `--model` and
`-c 'model_reasoning_effort="high"'`, following V1's argv conventions; extra
arguments remain separate argv items. Update checks are disabled for automation.

The selected node needs Node.js and the official Codex CLI on PATH. A small
inline Node driver runs under the node's PTY/pipe facilities, so it needs no
plugin files on a remote node and no controlling terminal. It runs
`codex login status` before accepting launch and before receiving the brief.
A failed/unknown check refuses with an instruction to run `codex login` there.
The CLI owns authentication; no credential file or daemon secret is read.

A known sign-in refusal retains an inspectable failed driver handle. Brief delivery
refuses before inference; the daemon then retires that exact generation, disposes
the clean workspace and closes its launch intent, allowing a signed-in retry.
The readiness control frame is larger than any completion snapshot; a node that
cannot retain complete control frames refuses readiness. Completion counters are
cumulative, so activity remains correct when older transcript lines roll away.

Briefs and follow-up messages are delivered as keyed JSON lines to that driver.
It runs `codex exec --json -`, sends the exact prompt over stdin, and then uses
`codex exec resume <thread_id> --json -` for subsequent turns, serialized in
arrival order. It never resumes an unrelated latest session. CLI JSON events
identify completion, failure and the last assistant reply (bounded to its final
8,192 UTF-16 code units). The driver stays running/idle between turns. Stop goes
through the node, which stops its process group and retains the workspace.
An explicit host command override uses the standard raw node lifecycle for
conformance. Changing configuration requires a daemon restart.

Validation: `armada plugin test packages/plugins/codex`; the process-backed
fake CLI lifecycle tests for both runtimes are in `test/runtime.test.ts`.
Real trial on 2026-10-30: Codex CLI 0.164.0 was invoked through this provider and
the local node's filtered environment. It refused for unavailable credentials;
no inference ran. Sign in with the CLI on the selected node before retrying.

CLI reference: <https://developers.openai.com/codex/noninteractive>.
