import { doctor } from "../devx.ts";
import type { Command } from "./command.ts";

export default {
  name: "doctor",
  summary: "Check Armada setup",
  usage: {
    setup: `  armada doctor [--org UUID] [--json]      Check session, server, GitHub, hosts and model accounts`,
  },
  help: `Usage: armada doctor [--org UUID] [--json]
Inspect setup metadata and report check statuses with next-step guidance.
Checks include session/server, GitHub, organization selection, Docker-host and model-account metadata.
Use --org to override a saved selection; a sole organization can be selected automatically.
This is not a full provider lifecycle test or proof that a model request will work.
--json returns a checks array; otherwise output is a table.
Exits 1 if any check is failed, otherwise 0; warnings and unknowns are not passes.
Example: armada doctor --org ORG_UUID --json
`,
  completionBefore: "bind-credential",
  async run(argv, { io, auth }) {
    return doctor(argv, { ...auth, ...io });
  },
} satisfies Command;
