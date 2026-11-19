import { orgCommand, vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

export default {
  name: "org",
  summary: "Manage organizations and membership",
  usage: {
    org: `  armada org create <name>                 Create an org; you are its first admin
  armada org list
  armada org setup [--org <name>]          Show organization provider setup status
  armada org connect boat|modal [--org <name>] [--file <path>]
                                           Connect an org provider using hidden input, stdin or a file
  armada org use <name|UUID|none>           Persist selection for this Armada server
  armada org current                        Show selected organization`,
    invitations: `  armada org invitations create <email> [--role admin|member] [--org <name|UUID>] [--json]
  armada org invitations list [--org <name|UUID>] [--json]
  armada org invitations resend|revoke <id> [--org <name|UUID>] [--json]
                                           Admin invitation management; --org overrides org use selection.
                                           Email sent means provider accepted, not confirmed inbox delivery.
  armada org invitations accept [--file <path>] [--json]
                                           Token from stdin/file only; log in personally with the matching
                                           verified email first. Opening a link never joins an organization.
  armada org members list|add|remove|role  [--org <name>] add <email> [--role admin|member]
                                           Direct membership administration; add requires an existing account,
                                           grants membership immediately and does not send an invitation.`,
  },
  help: `Usage: armada org <command> [arguments]
Manage organization selection, provider setup and membership.
Use a leaf command with --help or -h for flags and authorization requirements.
  list         List your organizations, roles and IDs.
  use          Save a local default by name/UUID, or clear it with none.
  current      Read the saved selection; not a current-membership check.
  create       Create an organization and become its admin.
  setup        Inspect provider configuration, not lifecycle readiness.
  connect      Connect Boat/Modal as an organization admin.
  members      List/add/change roles/remove members.
  invitations  Create/list/resend/revoke/accept invitations.
Explicit --org overrides a saved default on commands that consume it.
Help does not sign in, change selection, read credentials or call the server.
Example: armada org list --json
Example: armada org invitations --help
`,
  subcommandHelp: {
    "org members": `Usage: armada org members <command> [arguments]
  list    List members and roles.
  add     Add by email; --role defaults to member.
  role    Change role using positional email and admin|member.
  remove  Remove by email.
Membership changes require an organization admin; server authorization still applies.
Use leaf --help/-h for organization selection and exact flags.
Example: armada org members list --org my-team --json
`,
    "org invitations": `Usage: armada org invitations <command> [arguments]
  create  Invite by email with optional role (default member).
  list    Read invitation metadata and IDs, never acceptance tokens.
  resend  Resend by invitation ID.
  revoke  Revoke by invitation ID.
  accept  Read a token from stdin/private file, never command arguments.
Management requires an organization admin and selected organization.
Accept uses the signed-in identity, not --org. See leaf --help/-h for flags.
Sent means email-provider acceptance, not confirmed inbox delivery.
Example: armada org invitations list --org my-team --json
`,
    "org list": `Usage: armada org list [--json]
List your organizations after Armada login, including their IDs and your roles.
Use an exact organization name or UUID with armada org use.
Example: armada org list --json
`,
    "org use": `Usage: armada org use <name|UUID|none>
Save a default organization for this Armada server in local preferences.
Selecting a name or UUID requires login and an exact, unambiguous organization match.
Use none to clear the saved selection locally; this does not delete an organization.
For commands that use the saved default, an explicit --org overrides it.
Example: armada org use my-team
Example: armada org use none
`,
    "org current": `Usage: armada org current
Read the saved local organization selection for this Armada server, without a server request.
Output is JSON: org is the saved UUID, or null when no selection is saved.
This does not check current membership or access.
Example: armada org current
`,
    "org create": `Usage: armada org create <name> [--json]
Create an organization after Armada login; you become its admin.
Next, configure its provider with armada org connect boat|modal --org <id>.
Supply provider credentials through stdin/hidden input or a private file, never arguments.
Example: armada org create my-team --json
`,
    "org members list": `Usage: armada org members list [--org <name>] [--json]
List organization members and roles after Armada login and server authorization.
Use --org to override a saved organization selection.
Example: armada org members list --org my-team --json
`,
    "org members add": `Usage: armada org members add <email> [--role admin|member] [--org <name>] [--json]
Add a member as an organization admin after Armada login; the default role is member.
Use --org to override a saved organization selection.
Example: armada org members add teammate@example.com --role member --org my-team
`,
    "org members role": `Usage: armada org members role <email> <admin|member> [--org <name>] [--json]
Change a member's role as an organization admin after Armada login.
The new role is positional, not a --role flag. Use --org to override a saved selection.
Example: armada org members role teammate@example.com admin --org my-team
`,
    "org members remove": `Usage: armada org members remove <email> [--org <name>] [--json]
Remove a member as an organization admin after Armada login.
Use --org to override a saved organization selection.
Example: armada org members remove teammate@example.com --org my-team
`,
    "org invitations create": `Usage: armada org invitations create <email> [--role admin|member] [--org <name|UUID>] [--json]
Invite someone as an organization admin after Armada login; the default role is member.
Select an organization with --org or armada org use.
Sent means the email provider accepted delivery, not confirmed inbox receipt.
Example: armada org invitations create teammate@example.com --org my-team
`,
    "org invitations list": `Usage: armada org invitations list [--org <name|UUID>] [--json]
List invitation metadata as an organization admin after Armada login.
Select an organization with --org or armada org use; output includes IDs, not tokens.
Example: armada org invitations list --org my-team --json
`,
    "org invitations resend": `Usage: armada org invitations resend <id> [--org <name|UUID>] [--json]
Resend an invitation as an organization admin after Armada login.
Use an invitation ID from org invitations list, and select --org or armada org use.
Sent means email-provider acceptance, not confirmed inbox receipt.
Example: armada org invitations resend INVITATION_UUID --org my-team
`,
    "org invitations revoke": `Usage: armada org invitations revoke <id> [--org <name|UUID>] [--json]
Revoke an invitation as an organization admin after Armada login.
Use an invitation ID from org invitations list, and select --org or armada org use.
Example: armada org invitations revoke INVITATION_UUID --org my-team
`,
    "org invitations accept": `Usage: armada org invitations accept [--file <path>] [--json]
Accept an invitation after Armada login using a token from stdin or a private file.
Never put the token in command arguments. --org is not accepted by this command.
The server validates the invitation and signed-in identity; the token is not printed.
Example: armada org invitations accept --file /private/invitation-token
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
  helpWhenBare: true,
  useSelectedOrg: (argv) => ["members", "setup", "connect"].includes(argv[0] ?? ""),
  async run(argv, { auth, deps }) {
    return orgCommand(argv, vaultIo(auth, deps));
  },
} satisfies Command;
