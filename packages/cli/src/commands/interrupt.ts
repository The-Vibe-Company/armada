import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "interrupt",
  summary: "Interrupt a running turn",
  usage: ``,
  help: `Usage: armada interrupt <sandbox-id> [--org UUID] [--json]
Interrupt the sandbox's running turn after Armada login and authorization.
The sandbox stays up for the next send. This does not stop or delete the machine.
Availability depends on the provider/harness; the server can refuse unsupported interruption.
Output is JSON even without --json.
Example: armada interrupt SANDBOX_UUID --org ORG_UUID --json
`,
});
