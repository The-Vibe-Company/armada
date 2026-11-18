import { HARNESSES } from "@armada/core";
import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "list",
  summary: "List visible sandboxes",
  usageGroup: "list",
  usage: `  armada list [--status STATUS] [--agent|--harness ${HARNESSES.join("|")}] [--golden UUID] [--owner UUID|me]
              [--page N] [--limit 1..200] [--org UUID] [--json] [--page-info]
                                           Default page size 25; --json keeps {sandboxes:[...]}; --page-info adds exact totals`,
  help: `Usage: armada list [--status <status>] [--agent <harness> | --harness <harness>]
  [--golden UUID] [--owner UUID|me] [--page <N>] [--limit <N>] [--org UUID] [--json] [--page-info]
List visible sandboxes after Armada login and server authorization.
Status: starting, ready, running, stopping, stopped, failed or deleted.
Deleted sandboxes are excluded by default; request --status deleted to include them.
--agent and --harness are aliases; use only one (claude, codex or opencode).
--golden filters by snapshot UUID. --owner accepts a user UUID or me.
Page is 1–1000000; limit is 1–200 (default page size 25). This is one page, not all results.
Human output is a table. --json returns {sandboxes:[...]}; --page-info returns full
page metadata and exact totals as JSON even without --json.
Use --org to override a saved selection. Reuse returned IDs with status/logs/send.
Example: armada list --owner me --page 1 --limit 25 --json
Example: armada list --org ORG_UUID --page 2 --page-info
`,
});
