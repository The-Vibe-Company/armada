import { accountCommand } from "../account-commands.ts";
import type { Command } from "./command.ts";

function authorizationHelp(verb: "add" | "login") {
  const purpose =
    verb === "add"
      ? "Start GitHub App installation and wait for a new installation."
      : "Authorize or reauthorize GitHub and wait for this flow to complete.";
  return `Usage: armada account ${verb} github [--no-browser] [--timeout <seconds>] [--json]
${purpose} Requires a personal Armada login.
--no-browser prints the authorization URL and instructions to stderr.
--timeout accepts 0 to 600 seconds (default 300). Zero still starts the flow and checks once.
After a timeout, inspect armada account ls github before retrying.
`;
}

export default {
  name: "account",
  summary: "Manage GitHub access and inspect your Armada session",
  usage: {
    account: `  armada account ls|add|login|rm github      GitHub connection and installation
  armada account status|logout               Armada identity / revoke current login session`,
  },
  help: `Usage: armada account <command> [arguments]
Manage GitHub access or inspect your personal Armada session.
  ls github      Inspect your GitHub connection and installations.
  add github     Start GitHub App installation and wait for a new installation.
  login github  Authorize or reauthorize GitHub.
  rm github      Disconnect your GitHub account.
Use leaf --help/-h for exact syntax and authorization requirements.
  status  Read account status from the server as JSON.
  logout  Sign out the current personal session remotely, then clear local login.
For local-only session clearing, use armada logout instead.
Account logout requires a personal session, not service-token authentication;
remove ARMADA_TOKEN from that command's environment when using saved personal login.
Help makes no server requests and does not sign anything out.
Example: armada account login github --help
Example: armada account logout --help
`,
  subcommandHelp: {
    "account ls github": `Usage: armada account ls github [--json]
Read GitHub connection and installation metadata as JSON. Requires a personal Armada login.
`,
    "account add github": authorizationHelp("add"),
    "account login github": authorizationHelp("login"),
    "account rm github": `Usage: armada account rm github [--json]
Disconnect your GitHub account. Requires a personal Armada login.
`,
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
    return accountCommand(argv, auth);
  },
} satisfies Command;
