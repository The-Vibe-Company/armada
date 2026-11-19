import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "exec",
  summary: "Run a shell command",
  usage: ``,
  help: `Usage: armada exec <sandbox-id> <command> [--cwd <path>] [--timeout <seconds>] [--org UUID] [--json]
Run a shell command after Armada login and server authorization; not an agent prompt.
Default cwd is /home/user. Timeout is integer seconds 1–600 (default 120).
Output is JSON with command exitCode, stdout/stderr and timeout/truncation information.
Inspect exitCode and timedOut; a successful CLI request is not proof the shell command succeeded.
Put options before -- so command flags are passed literally, not parsed as Armada options.
Example: armada exec SANDBOX_UUID --org ORG_UUID -- "git status --short"
`,
});
