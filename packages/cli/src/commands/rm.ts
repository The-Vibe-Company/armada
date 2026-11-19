import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "rm",
  summary: "Delete a stopped sandbox",
  usage: `  armada rm <sandbox-id> --yes [--org UUID] [--json]  Permanently delete a stopped sandbox and its recovery archives`,
  help: `Usage: armada rm <sandbox-UUID> --yes [--org UUID] [--json]
Permanently delete a stopped sandbox after Armada login and server authorization.
Warning: deletion removes the disk AND recovery archives. --yes is required confirmation.
This is not stop. Inspect status and preserve needed work before deleting.
Use a sandbox UUID from armada list --json; names are not accepted.
Example: armada rm SANDBOX_UUID --yes --org ORG_UUID --json
`,
});
