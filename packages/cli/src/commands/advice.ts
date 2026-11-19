import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "advice",
  summary: "Read resource-sizing advice",
  usageGroup: "advice",
  usage: `  armada advice <sandbox-id> [--org UUID] [--json]
                                           Last-10 comparable-session resource evidence; collects one bounded sample.
                                           Missing/partial evidence abstains. Never resizes or changes defaults.
                                           Human launch guidance uses stderr only; --json launch never requests advice.`,
  help: `Usage: armada advice <sandbox-id> [--org UUID] [--json]
Read resource-sizing advice after Armada login and server authorization.
Collects one bounded sample and considers up to the last 10 comparable sessions.
Missing or partial evidence can produce no recommendation; do not treat unknowns as measured headroom.
This never resizes a running machine or changes defaults; recommendations concern future launches.
Human output summarizes supported advice or the no-recommendation reason.
Use --json to inspect the full evidence response. Use a sandbox ID from armada list.
Example: armada advice SANDBOX_UUID --org ORG_UUID --json
`,
});
