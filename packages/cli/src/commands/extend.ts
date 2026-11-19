import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "extend",
  summary: "Extend sandbox lifetime",
  usage: `  armada extend <sandbox-id> --ttl <duration> [--org UUID] [--json]
                                           TTL is measured from now, not added to the old deadline; must extend it.`,
  help: `Usage: armada extend <sandbox-UUID> --ttl <duration> [--org UUID] [--json]
Request a sandbox lifetime extension after Armada login and server authorization.
TTL is measured from now, not added to the old deadline, and must extend it.
Duration is a positive integer with optional s, m, h or d; a bare number is seconds.
Examples: 90, 90s, 30m, 4h, 2d. Server/provider state and lifetime limits still apply.
Use a sandbox UUID from armada list --json. Output is JSON even without --json.
Example: armada extend SANDBOX_UUID --ttl 30m --org ORG_UUID --json
`,
});
