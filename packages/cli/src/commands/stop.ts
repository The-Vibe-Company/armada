import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "stop",
  summary: "Stop the sandbox machine, interrupt a turn, or extend the deadline",
  usage: `  armada stop [sandbox-id] [--turn | --after DURATION] [--org UUID] [--json]`,
  help: `Usage: armada stop [sandbox-id] [--turn | --after DURATION] [--org UUID] [--json]
Without options, stop the machine now. Omit the ID to use the current sandbox.
--turn interrupts the running turn and keeps the machine up, where supported.
--after DURATION extends the sandbox lifetime from now. The new deadline must be later
than the current deadline and within server/provider limits. Use seconds or s, m, h, d
(e.g. 90, 30m, 4h or 2d).
Modal retains its disk only if checkpoint succeeds; fallback termination cannot resume.
Inspect the returned status/preservation note; do not assume disk retention.
After an uncertain outcome, run armada info or armada ls before retrying. This is not permanent rm deletion.
Output is JSON even without --json.
Example: armada stop SANDBOX_UUID --turn --org ORG_UUID --json
`,
});
