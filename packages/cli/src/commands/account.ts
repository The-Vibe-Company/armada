import { accountCommand } from "../account-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "account",
  summary: "Inspect your account or sign out remotely",
  usage: { account: `  armada account status|logout              Account identity / revoke current login session` },
  help: `Usage: armada account <command> [arguments]
Inspect your Armada account or sign out a personal session remotely.
Use leaf --help/-h for exact syntax and authorization requirements.
  status  Read account status from the server as JSON.
  logout  Sign out the current personal session remotely, then clear local login.
For local-only session clearing, use armada logout instead.
Account logout requires a personal session, not service-token authentication;
remove ARMADA_TOKEN from that command's environment when using saved personal login.
Help makes no server requests and does not sign anything out.
Example: armada account status --json
Example: armada account logout --help
`,
  subcommandHelp: {
    "account status": `Usage: armada account status [--json]
Read account status with authenticated access and server authorization.
Output is JSON even without --json. This is not a local session-file inspection.
Example: armada account status --json
`,
    "account logout": `Usage: armada account logout [--json]
Sign out the current personal login session remotely, then clear its local session.
Requires a personal login session; service-token authentication is not supported.
If ARMADA_TOKEN is set, remove it from this command's environment to use your personal session.
To clear only the saved local session, use armada logout.
--json returns {authenticated:false}.
Example: armada account logout
`,
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth }) {
    return accountCommand("account", argv, auth);
  },
} satisfies Command;
