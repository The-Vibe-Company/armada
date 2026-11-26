import { HARNESSES } from "@armada/core";
import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "ls",
  summary: "List visible sandboxes",
  usage: {
    sandboxes: `  armada ls [--status STATUS] [--agent ${HARNESSES.join("|")}] [--org ORG] [--json]
                                           List visible sandboxes (see ls --help for filters/pagination)`,
  },
  help: `Usage: armada ls [--status <status>] [--ref REF] [--agent <harness> | --harness <harness>]
  [--golden UUID] [--owner UUID|me] [--page <N>] [--limit <N>] [--org UUID] [--json] [--page-info]
List visible sandboxes after Armada login and server authorization.
Status: starting, ready, running, stopping, stopped, failed or deleted.
Deleted sandboxes are excluded by default; request --status deleted to include them.
--agent and --harness are aliases; use only one (${HARNESSES.join(" or ")}).
--ref matches the external reference supplied at launch.
--golden filters by snapshot UUID. --owner accepts a user UUID or me.
Page is 1–1000000; limit is 1–200 (default page size 25). This is one page, not all results.
Human output is a table. --json returns {sandboxes:[...]}; --page-info returns full
page metadata and exact totals as JSON even without --json.
Use --org to override a saved selection. Reuse returned IDs with info, events, or prompt.
Example: armada ls --owner me --page 1 --limit 25 --json
Example: armada ls --org ORG_UUID --page 2 --page-info
`,
});
