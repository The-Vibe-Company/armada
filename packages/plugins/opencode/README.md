# OpenCode runtime

Bundled `runtime.opencode`, Plugin API 0.2. The host binds the selected node with
`withNode`; preparation and all process writes stay on that node, under its
worker-generation guards. No registry or other plugin is imported.

Configuration under `runtime.opencode`:

```json
{
  "model": "provider/model",
  "effort": "high",
  "extraArgs": [],
  "command": "opencode"
}
```

All fields are optional. Host routing (`--model`, `--effort`) overrides the
configured model/effort. OpenCode receives `--model` and `--variant` for its
provider-specific effort. Extra arguments remain separate argv items.

The selected node needs Node.js and the official OpenCode CLI on PATH. An
inline Node driver runs under the node's PTY/pipe facilities, without needing
plugin files on a remote node or a controlling terminal. It runs
`opencode auth list` before accepting launch and before receiving the brief.
The supported CLI's credential/environment-variable count must report at least
one entry and exit successfully. Missing or unrecognized evidence refuses with
an instruction to run `opencode auth login` there. This checks credential
presence, not validity for every provider/model. Authentication output is never
forwarded, and no credential file or daemon secret is read.

A known sign-in refusal retains an inspectable failed driver handle. Brief delivery
refuses before inference; the daemon then retires that exact generation, disposes
the clean workspace and closes its launch intent, allowing a signed-in retry.
The readiness control frame is larger than any completion snapshot; a node that
cannot retain complete control frames refuses readiness. Completion counters are
cumulative, so activity remains correct when older transcript lines roll away.

Briefs and follow-up messages are delivered as keyed JSON lines to that driver.
It runs `opencode run --format json` with the exact prompt over stdin, then uses
`--session <sessionID>` on subsequent turns, serialized in arrival order. It
never resumes an unrelated latest session. JSON events identify the final
`step_finish` with reason `stop`, errors and assistant text (bounded to its final
8,192 UTF-16 code units). The driver stays running/idle between turns. Stop goes
through the node, which stops its process group and retains the workspace.
An explicit host command override uses the standard raw node lifecycle for
conformance. Changing configuration requires a daemon restart.

Validation: `armada plugin test packages/plugins/opencode`; process-backed fake
CLI lifecycle tests for both runtimes live in `../codex/test/runtime.test.ts`.
Real trial on 2026-10-30: OpenCode was absent in this VM; installed CLI 1.19.5
reported zero credentials. Invoking this provider through the local node
refused before inference. The owner must connect a provider on the selected node.

CLI reference: <https://dev.opencode.ai/docs/cli/>.
