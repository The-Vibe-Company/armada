import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "detail",
  summary: "Read detailed sandbox information",
  usage: `  armada detail|recovery|stop|interrupt <sandbox-id> [--org UUID] [--json]`,
  help: `Usage: armada detail <sandbox-id> [--org UUID] [--json]
Read detailed sandbox information after Armada login and server authorization.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
For recorded status without a provider probe, use armada status instead.
Example: armada detail SANDBOX_UUID --org ORG_UUID --json
`,
});
