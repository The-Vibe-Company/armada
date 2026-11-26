import { orgCommand, vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "org",
  summary: "List organizations and configure providers",
  usage: {
    hosts: `  armada org list                          List your organizations, roles and IDs
  armada org use <NAME|UUID|none> [--json] Set or clear your default organization
  armada org setup [--org <name>]          Show organization provider setup status
  armada org connect boat|modal [--org <name>] [--file <path>]
                                           Connect an org provider via stdin or private file`,
  },
  help: `Usage: armada org <command> [arguments]
List organizations and configure providers.
Use a leaf command with --help or -h for flags and authorization requirements.
  list         List your organizations, roles and IDs.
  use          Set or clear your default organization without signing in again.
  setup        Inspect provider configuration, not lifecycle readiness.
  connect      Connect Boat/Modal as an organization admin.
Explicit --org overrides a saved default on commands that consume it.
Help does not sign in, change selection, read credentials or call the server.
Example: armada org list --json
`,
  subcommandHelp: {
    "org list": `Usage: armada org list [--json]
List your organizations after Armada login, including their IDs and your roles.
Use an exact organization name or UUID with armada org use NAME|UUID.
Example: armada org list --json
`,
    "org use": `Usage: armada org use <NAME|UUID|none> [--json]
Set your default organization using the existing session, or pass none to clear it.
Matches an organization by exact name or UUID from armada org list.
Explicit --org overrides a saved default on commands that consume it.
Example: armada org use my-team
`,
    "org setup": `Usage: armada org setup [--org <name>] [--json]
Show organization provider setup status. Sign in before running the operation.
Use --org to override a saved selection. This reports configuration, not a live lifecycle test.
Example: armada org setup --org my-team
`,
    "org connect": `Usage: armada org connect boat|modal [--org <name>] [--file <path>] [--json]
Connect a provider as an organization admin after Armada login.
Boat takes an API key; Modal takes a token pair. See org connect boat|modal --help.
Read credentials from stdin/hidden input or a private file, never command arguments.
Use --org to override a saved organization selection.
Example: armada org connect modal --org my-team --file /private/modal.json
`,
    "org connect boat": `Usage: armada org connect boat [--org <name>] [--file <path>] [--json]
Connect Boat as an organization admin after Armada login.
Input: the Boat API key from stdin/hidden input or a private file, never command arguments.
Use --org to override a saved organization selection.
Example: armada org connect boat --org my-team --file /private/boat-key
`,
    "org connect modal": `Usage: armada org connect modal [--org <name>] [--file <path>] [--json]
Connect a Modal workspace as an organization admin after armada login.
Input: JSON with token_id and token_secret (from Modal), or a Modal token pair separated by whitespace.
Keep real credentials in a private file or stdin/hidden input, never command arguments.
Use --org to override a saved organization selection.
Example: armada org connect modal --org my-team --file /private/modal.json
`,
  },
  automaticJson: true,
  helpWhenBare: true,
  requireKnownSubcommand: true,
  useSelectedOrg: (argv) => ["setup", "connect"].includes(argv[0] ?? ""),
  async run(argv, { auth, deps }) {
    return orgCommand(argv, vaultIo(auth, deps));
  },
} satisfies Command;
