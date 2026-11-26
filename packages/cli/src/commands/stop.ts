import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "stop",
  summary: "Stop the sandbox machine or interrupt its current turn",
  usage: `  armada stop [sandbox-id] [--turn | --after [--timeout S]] [--org ORG] [--json]
                                           Stop the sandbox machine or interrupt its current turn`,
  help: `Usage: armada stop [sandbox-id] [--turn | --after [--timeout SECONDS]] [--org UUID] [--json]
Without options, stop the machine now. Omit the ID to use the current sandbox.
--turn interrupts the running turn and keeps the machine up, where supported.
--after waits for the turn to settle, then stops only if the sandbox is still idle.
--timeout accepts 0–600 seconds with --after (default 60). A zero timeout only observes
status. A receipt with timedOut: true means no stop was requested.
Modal retains its disk only if checkpoint succeeds; fallback termination cannot resume.
Inspect the returned status/preservation note; do not assume disk retention.
After an uncertain outcome, run armada info or armada ls before retrying. This is not permanent rm deletion.
Output is JSON even without --json.
Example: armada stop SANDBOX_UUID --turn --org ORG_UUID --json
`,
});
