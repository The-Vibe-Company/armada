import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "status",
  summary: "Inspect Armada setup or sandbox status",
  usage: {
    setup: "  armada status [--setup] [--org UUID] [--json]  Check identity, server, GitHub, hosts and accounts",
    sandbox: `  armada status <sandbox-id> [--live] [--org UUID] [--json]
                                           Recorded state by default (no provider probe); --live reads provider/prompt details`,
  },
  help: `Usage: armada status [--setup] [--org UUID] [--json]
       armada status [sandbox-id] [--live] [--org UUID] [--json]
Without a sandbox ID or current sandbox, check identity, selected organization,
server, GitHub, hosts and model accounts. Use --setup to inspect setup from a
sandbox workspace. Setup reports metadata and exits 1 if a check fails.
An explicit ID, ARMADA_SANDBOX or .armada/sandbox selects sandbox status.
Default: recorded state, without a provider probe. --live reads provider/prompt details.
Use a sandbox ID from armada ls --json. Output is JSON even without --json.
Recorded state is not proof of current provider readiness.
Example: armada status --setup --org ORG_UUID --json
Example: armada status SANDBOX_UUID --org ORG_UUID --json
Example: armada status SANDBOX_UUID --live --org ORG_UUID
`,
});
