import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "wait",
  summary: "Wait for sandbox activity",
  usage: `  armada wait <sandbox-id> [--timeout <seconds>] [--org UUID] [--json]
                                           Timeout is 0–600 seconds, default 60.`,
  help: `Usage: armada wait <sandbox-id> [--timeout <seconds>] [--org UUID] [--json]
Wait for sandbox activity through the server after Armada login and authorization.
Timeout is an integer from 0 to 600 seconds (default 60); zero is accepted.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
Inspect the returned state; a bounded wait is not proof that your task is complete.
Example: armada wait SANDBOX_UUID --timeout 60 --org ORG_UUID --json
`,
});
