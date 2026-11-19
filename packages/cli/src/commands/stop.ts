import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "stop",
  summary: "Stop the sandbox machine",
  usage: ``,
  help: `Usage: armada stop <sandbox-id> [--org UUID] [--json]
Stop the machine after Armada login and server authorization, not just the running turn.
Modal retains its disk only if checkpoint succeeds; fallback termination cannot resume.
Inspect the returned status/preservation note; do not assume disk retention.
After an uncertain outcome, inspect status/list before retrying. This is not permanent rm deletion.
Output is JSON even without --json.
Example: armada stop SANDBOX_UUID --org ORG_UUID --json
`,
});
