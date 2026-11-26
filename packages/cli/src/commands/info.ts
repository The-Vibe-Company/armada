import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "info",
  summary: "Inspect Armada setup or sandbox status",
  usage: {
    sandboxes: `  armada info [sandbox-id] [--live | --wait [--timeout S]] [--org ORG] [--json]
                                           Inspect sandbox state, probe provider, or wait for activity
  armada info --setup [--org ORG] [--json] Check identity, server, GitHub, hosts and accounts`,
  },
  help: `Usage: armada info [--setup] [--org UUID] [--json]
       armada info [sandbox-id] [--live | --wait [--timeout seconds]] [--prompt-id ID] [--org UUID] [--json]
An explicit ID, ARMADA_SANDBOX or .armada/sandbox selects a sandbox.
Without a sandbox, inspect Armada setup. Use --setup to force setup inspection.
--live reads current provider and prompt details. The default reads recorded state.
--wait waits for sandbox activity. Timeout is 0–600 seconds, default 60.
A bounded wait is not proof that the task is complete. Inspect the returned state.
Use --json for machine-readable sandbox output. Setup reports its checks and exits 1 if a check fails.
Example: armada info SANDBOX_UUID --wait --timeout 60 --org ORG_UUID --json
`,
});
