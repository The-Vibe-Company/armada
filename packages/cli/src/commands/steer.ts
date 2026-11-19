import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "steer",
  summary: "Redirect a running turn",
  usage: ``,
  help: `Usage: armada steer <sandbox-id> <text> [--conversation <id>] [--org UUID] [--json]
Redirect a currently running turn after Armada login and server authorization.
Refused when no turn is running; use send for a new turn.
Delivery may join the turn natively or interrupt/restart the same conversation;
inspect the returned delivery field. Output is JSON even without --json.
Put options before -- to pass literal option-like text.
Example: armada steer SANDBOX_UUID --org ORG_UUID -- "Focus on the failing test"
`,
});
