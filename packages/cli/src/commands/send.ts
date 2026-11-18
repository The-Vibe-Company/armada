import { sandboxOperation } from "./sandbox-operation.ts";

export default sandboxOperation({
  name: "send",
  summary: "Send a new instruction",
  usage: `  armada send|steer|exec <sandbox-id> <text-or-command> [--model ID] [--reasoning-effort LEVEL]
                                           send accepts --request-id UUID to reuse an uncertain runtime instruction.
                                           Full-account follow-up sends can queue FIFO; queued is not completed.`,
  help: `Usage: armada send <sandbox-id> <text> [--conversation <id>] [--model <id>] [--reasoning-effort <level>]
  [--request-id UUID] [--org UUID] [--json]
Send a new instruction after Armada login and server authorization.
Use steer to redirect a running turn. Retained stopped sandboxes can wake on send.
Native model/effort overrides apply to this turn only; runtime model/effort remain launch-pinned.
For uncertain runtime delivery, reuse the request ID with identical input.
Native providers do not deduplicate by request ID; inspect state before retrying.
Output is JSON; human mode also reports acceptance progress on stderr.
Put options before -- when the literal text contains option-like words.
Example: armada send SANDBOX_UUID --org ORG_UUID -- "Review the changes"
`,
});
