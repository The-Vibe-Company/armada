import { AuthError } from "@armada/auth";
import { logoutCommand } from "../auth-commands.ts";
import { parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

export default {
  name: "logout",
  summary: "Clear saved Armada login",
  usage: { session: `  armada logout` },
  help: `Usage: armada logout [--json]
Clear the saved local Armada login without a server request.
--json returns {authenticated:false}.
This does not revoke service tokens or remove ARMADA_TOKEN from your environment.
To sign out a personal session remotely first, use armada account logout.
Example: armada logout
`,
  useSelectedOrg: false,
  async run(argv, { auth }) {
    const parsed = parseAuth(argv);
    rejectUnknown(parsed.flags, ["json"]);
    if (parsed.position.length > 0) throw new AuthError("Run armada logout.", "usage");
    await logoutCommand(auth, parsed.flags.has("json"));
    return 0;
  },
} satisfies Command;
