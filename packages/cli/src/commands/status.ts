import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "status",
  summary: "Read sandbox status",
  usage: `  armada status <sandbox-id> [--live] [--org UUID] [--json]
                                           Recorded state by default (no provider probe); --live reads provider/prompt details`,
  help: `Usage: armada status <sandbox-id> [--live] [--org UUID] [--json]
Read sandbox status after Armada login and server authorization.
Default: recorded state, without a provider probe. --live reads provider/prompt details.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
Recorded state is not proof of current provider readiness.
Example: armada status SANDBOX_UUID --org ORG_UUID --json
Example: armada status SANDBOX_UUID --live --org ORG_UUID
`,
});
