import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "report",
  summary: "Report a finished turn outcome",
  usage: `  armada report <sandbox-id> ready|blocked --prompt-id ID [--reason TEXT] [--pr-number N] [--pr-url URL] [--head-sha SHA]`,
  help: `Usage: armada report <sandbox-id> ready|blocked --prompt-id <id> [--org UUID] [--json]
  ready: [--pr-number <N>] [--pr-url <URL>] [--head-sha <SHA>]
  blocked: --reason <text>
Report an explicit outcome for the latest finished turn after Armada login.
Only the sandbox owner or current organization admin may report.
Call after wait; use the latest finished prompt ID, not an arbitrary earlier turn.
A new send clears the outcome. Message text alone is not a reported outcome.
Blocked requires a nonempty reason (maximum 1000 characters).
Ready accepts optional PR metadata; the report itself does not verify CI or merge a PR.
Output is JSON even without --json.
Example: armada report SANDBOX_UUID blocked --prompt-id PROMPT_ID --reason "Need owner input"
Example: armada report SANDBOX_UUID ready --prompt-id PROMPT_ID --pr-number 123
`,
});
