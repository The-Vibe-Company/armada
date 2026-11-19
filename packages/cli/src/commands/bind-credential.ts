import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "bind-credential",
  summary: "Recover a legacy Modal credential binding",
  usage: {
    "bind-credential": `  armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
                                           Owner-only legacy Modal binding recovery; stop safely first; no restart`,
  },
  help: `Usage: armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
Owner-only legacy Modal credential-binding recovery after Armada login.
Stop the sandbox safely before rebinding; this command does not restart it.
Use a sandbox ID from armada list and a credential-account UUID from creds list.
Do not pass secret credential values. Output is JSON even without --json.
Example: armada bind-credential SANDBOX_UUID --credential-id ACCOUNT_UUID --org ORG_UUID
`,
});
