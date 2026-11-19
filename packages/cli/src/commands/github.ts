import { accountCommand } from "../account-commands.ts";
import type { Command } from "./command.ts";

function githubAuthorizationHelp(action: "connect" | "reconnect" | "install") {
  const purpose =
    action === "install"
      ? "Start GitHub App installation and wait for a newly observed installation."
      : action === "reconnect"
        ? "Start GitHub reauthorization and wait for this authorization flow to connect."
        : "Start GitHub authorization and wait for this authorization flow to connect.";
  return `Usage: armada github ${action} [--no-browser] [--timeout <seconds>] [--json]
${purpose}
Requires Armada login. Opens the authorization URL in your browser by default.
--no-browser prints authorization instructions and the URL to stderr instead.
--timeout is an integer from 0 to 600 seconds (default 300).
Zero still starts authorization and checks status; it does not assume success.
On timeout, check armada github status before retrying; no success is assumed.
Successful output is JSON even without --json.
Example: armada github ${action} --no-browser --timeout 300
`;
}

export default {
  name: "github",
  summary: "Manage GitHub authorization and installation",
  usage: {
    github: `  armada github status|connect|reconnect|disconnect|install|manage [installation-id]
  armada github refresh <sandbox>
                                           Browser authorization waits for real completion; --no-browser prints URL`,
  },
  help: `Usage: armada github <command> [arguments]
Manage your GitHub connection after Armada login.
Use leaf --help/-h for exact flags, timeouts and server authorization requirements.
  status      Read connection and installation metadata as JSON.
  connect     Start authorization and wait for its connected state.
  reconnect   Start reauthorization and wait for its connected state.
  disconnect  Disconnect the GitHub connection.
  install     Start App installation and wait for a newly observed installation.
  manage      Open settings using an installation ID from status.
  refresh     Refresh credentials using a sandbox ID, not an installation ID.
Manage --no-browser prints a settings URL to stdout; authorization --no-browser
prints instructions to stderr. A URL alone is not proof of authorization.
Help does not open a browser or make GitHub/API requests.
Example: armada github status --json
Example: armada github connect --help
`,
  subcommandHelp: {
    "github status": `Usage: armada github status [--json]
Read your GitHub connection and installation metadata after Armada login.
Output is JSON even without --json. Use an installation ID with github manage.
Example: armada github status --json
`,
    "github manage": `Usage: armada github manage <installation-id> [--no-browser] [--json]
Open settings for one of your GitHub installations after Armada login.
Choose an installation ID from armada github status, not a sandbox ID.
--no-browser prints the settings URL to stdout instead of opening a browser.
--json returns {url} without opening a browser.
Example: armada github manage INSTALLATION_ID --no-browser
`,
    "github refresh": `Usage: armada github refresh <sandbox-id> [--json]
Request GitHub credential refresh for an existing sandbox after Armada login.
Requires server authorization; use a sandbox ID, not an installation ID.
Output is JSON even without --json. This is not a reconnect of your GitHub account.
Example: armada github refresh SANDBOX_UUID --json
`,
    "github disconnect": `Usage: armada github disconnect [--json]
Disconnect your GitHub connection after Armada login and server authorization.
Output is JSON even without --json. To connect again, use armada github connect.
Example: armada github disconnect
`,
    "github connect": githubAuthorizationHelp("connect"),
    "github reconnect": githubAuthorizationHelp("reconnect"),
    "github install": githubAuthorizationHelp("install"),
  },
  helpWhenBare: true,
  useSelectedOrg: false,
  async run(argv, { auth }) {
    return accountCommand("github", argv, auth);
  },
} satisfies Command;
