import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "recovery",
  summary: "Read sandbox work-recovery information",
  usage: ``,
  help: `Usage: armada recovery <sandbox-id> [--org UUID] [--json]
Read sandbox work-recovery information after Armada login and server authorization.
Output is JSON even without --json. This is not credential-account rebinding.
Use a sandbox ID from armada list --json.
Example: armada recovery SANDBOX_UUID --org ORG_UUID --json
`,
  useSelectedOrg: false,
});
