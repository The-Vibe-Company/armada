// Exact command boundaries only: never interpret payload or remote arguments as help.
const HELP: Record<string, string> = {
  org: `Usage: armada org <command> [arguments]
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
  "token create": `Usage: armada token create [--org <name>] [--label <label>] [--json]
Create a service token with authenticated access and server authorization.
An explicit --org overrides a saved organization selection.
Warning: stdout contains the new secret, including with --json. Store it securely now;
Armada stores only its hash. Never commit it or send output to public logs.
Supply the token to scripts using ARMADA_TOKEN through a secure environment, not arguments.
Example: armada token create --org my-team --label automation
`,
  "token list": `Usage: armada token list [--json]
List service-token metadata with authenticated access and server authorization.
Output includes IDs and revocation state, not token values. Use an ID with token revoke.
Example: armada token list --json
`,
  "token revoke": `Usage: armada token revoke <id> [--json]
Revoke a service token with authenticated access and server authorization.
Use its ID from armada token list --json, never the secret token value.
Example: armada token revoke TOKEN_UUID
`,
  "github status": `Usage: armada github status [--json]
Read your GitHub connection and installation metadata after Armada login.
Output is JSON even without --json. Use an installation ID with github manage.
Example: armada github status --json
`,
  "github manage": `Usage: armada github manage <installation-id> [--no-browser]
Open settings for one of your GitHub installations after Armada login.
Choose an installation ID from armada github status, not a sandbox ID.
--no-browser prints the settings URL to stdout instead of opening a browser.
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
  "account status": `Usage: armada account status [--json]
Read account status with authenticated access and server authorization.
Output is JSON even without --json. This is not a local session-file inspection.
Example: armada account status --json
`,
  "account logout": `Usage: armada account logout
Sign out the current personal login session remotely, then clear its local session.
Requires a personal login session; service-token authentication is not supported.
If ARMADA_TOKEN is set, remove it from this command's environment to use your personal session.
To clear only the saved local session, use armada logout.
Example: armada account logout
`,
  logout: `Usage: armada logout
Clear the saved local Armada login without a server request.
This does not revoke service tokens or remove ARMADA_TOKEN from your environment.
To sign out a personal session remotely first, use armada account logout.
Example: armada logout
`,
  "mcp list": `Usage: armada mcp list [--org UUID] [--json]
List visible MCP registry connections after Armada login and server authorization.
Select an organization with armada org use or --org UUID.
Output is JSON even without --json. This is not a sandbox's bound-connection list.
Example: armada mcp list --org ORG_UUID --json
`,
  "mcp catalog": `Usage: armada mcp catalog [--org UUID] [--json]
Read the MCP service catalog after Armada login and server authorization.
Select an organization with armada org use or --org UUID.
Output is JSON even without --json; this command does not add a connection.
Example: armada mcp catalog --org ORG_UUID --json
`,
  "mcp status": `Usage: armada mcp status <connection-id> [--org UUID] [--json]
Read an MCP connection's status after Armada login and server authorization.
Use a connection ID from mcp list, not a sandbox ID.
Select an organization with armada org use or --org UUID. Output is always JSON.
Example: armada mcp status CONNECTION_UUID --org ORG_UUID --json
`,
  "mcp sandbox-connections": `Usage: armada mcp sandbox-connections <sandbox-UUID> [--org UUID] [--json]
Read actual bound MCP connection metadata for a sandbox after Armada login.
Requires server authorization and an organization selected with org use or --org UUID.
Use a sandbox UUID, not a registry connection ID. Output is always JSON.
This command does not mutate bindings.
Example: armada mcp sandbox-connections SANDBOX_UUID --org ORG_UUID --json
`,
  "mcp revoke": `Usage: armada mcp revoke <connection-id> [--org UUID] [--json]
Revoke an MCP connection's authorization after Armada login and server authorization.
Select an organization with org use or --org UUID; use an ID from mcp list.
Output is JSON even without --json. This is not mcp delete.
Example: armada mcp revoke CONNECTION_UUID --org ORG_UUID
`,
  "mcp rename": `Usage: armada mcp rename <connection-id> <name> [--org UUID] [--json]
Rename an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json.
Example: armada mcp rename CONNECTION_UUID work-tools --org ORG_UUID
`,
  "mcp default": `Usage: armada mcp default <connection-id> on|off [--org UUID] [--json]
Set whether an MCP connection is a launch default after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
The on/off choice is positional. This is not connection authorization.
Output is JSON even without --json.
Example: armada mcp default CONNECTION_UUID on --org ORG_UUID
`,
  "mcp enable": `Usage: armada mcp enable <connection-id> [--org UUID] [--json]
Enable an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. Check mcp status for authorization state.
Example: armada mcp enable CONNECTION_UUID --org ORG_UUID
`,
  "mcp disable": `Usage: armada mcp disable <connection-id> [--org UUID] [--json]
Disable an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. This is not registry deletion.
Example: armada mcp disable CONNECTION_UUID --org ORG_UUID
`,
  "mcp delete": `Usage: armada mcp delete <connection-id> [--org UUID] [--json]
Delete an MCP registry connection after Armada login and server authorization.
Use an ID from mcp list; select an organization with org use or --org UUID.
Output is JSON even without --json. For authorization revocation, see mcp revoke.
Example: armada mcp delete CONNECTION_UUID --org ORG_UUID
`,
  "mcp add": `Usage: armada mcp add <name> <URL> [--scope personal|org] [--org UUID] [--json]
   or: armada mcp add <name> --service <service-id> [--scope personal|org] [--org UUID] [--json]
   or: armada mcp add [--file <path>] [--org UUID] [--json]
Create a registry connection after Armada login and server authorization.
Select an organization with org use or --org UUID.
URL shortcuts require a public/OAuth HTTP URL without credentials; keep stdin empty.
Do not combine NAME URL with --file or stdin JSON. Shortcut scope defaults to personal.
Use mcp catalog for service IDs. Full definitions are JSON objects from stdin or --file;
put scope in the definition, not --scope. Secrets belong in private files/stdin, never arguments.
Output is always JSON. This does not run mcp connect.
Example: armada mcp add work-tools --service notion --org ORG_UUID
Example: armada mcp add --file /private/connection.json --org ORG_UUID
`,
  "mcp update": `Usage: armada mcp update <connection-id> [--file <path>] [--org UUID] [--json]
Update a registry connection from a JSON object after Armada login and server authorization.
Select an organization with org use or --org UUID; use an ID from mcp list.
Read the object from stdin or --file. Keep authentication values out of command arguments.
Updates cannot change scope; --scope is not accepted. Output is always JSON.
Example: armada mcp update CONNECTION_UUID --file /private/connection.json --org ORG_UUID
`,
  doctor: `Usage: armada doctor [--org UUID] [--json]
Inspect setup metadata and report check statuses with next-step guidance.
Checks include session/server, GitHub, organization selection, Docker-host and model-account metadata.
Use --org to override a saved selection; a sole organization can be selected automatically.
This is not a full provider lifecycle test or proof that a model request will work.
--json returns a checks array; otherwise output is a table.
Exits 1 if any check is failed, otherwise 0; warnings and unknowns are not passes.
Example: armada doctor --org ORG_UUID --json
`,
  recovery: `Usage: armada recovery <sandbox-id> [--org UUID] [--json]
Read sandbox work-recovery information after Armada login and server authorization.
Output is JSON even without --json. This is not credential-account rebinding.
Use a sandbox ID from armada list --json.
Example: armada recovery SANDBOX_UUID --org ORG_UUID --json
`,
  "bind-credential": `Usage: armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
Owner-only legacy Modal credential-binding recovery after Armada login.
Stop the sandbox safely before rebinding; this command does not restart it.
Use a sandbox ID from armada list and a credential-account UUID from creds list.
Do not pass secret credential values. Output is JSON even without --json.
Example: armada bind-credential SANDBOX_UUID --credential-id ACCOUNT_UUID --org ORG_UUID
`,
  extend: `Usage: armada extend <sandbox-UUID> --ttl <duration> [--org UUID] [--json]
Request a sandbox lifetime extension after Armada login and server authorization.
Duration is a positive integer with optional s, m, h or d; a bare number is seconds.
Examples: 90, 90s, 30m, 4h, 2d. Server/provider state and lifetime limits still apply.
Use a sandbox UUID from armada list --json. Output is JSON even without --json.
Example: armada extend SANDBOX_UUID --ttl 30m --org ORG_UUID --json
`,
  rm: `Usage: armada rm <sandbox-UUID> --yes [--org UUID] [--json]
Permanently delete a stopped sandbox after Armada login and server authorization.
Warning: deletion removes the disk AND recovery archives. --yes is required confirmation.
This is not stop. Inspect status and preserve needed work before deleting.
Use a sandbox UUID from armada list --json; names are not accepted.
Example: armada rm SANDBOX_UUID --yes --org ORG_UUID --json
`,
  status: `Usage: armada status <sandbox-id> [--live] [--org UUID] [--json]
Read sandbox status after Armada login and server authorization.
Default: recorded state, without a provider probe. --live reads provider/prompt details.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
Recorded state is not proof of current provider readiness.
Example: armada status SANDBOX_UUID --org ORG_UUID --json
Example: armada status SANDBOX_UUID --live --org ORG_UUID
`,
  detail: `Usage: armada detail <sandbox-id> [--org UUID] [--json]
Read detailed sandbox information after Armada login and server authorization.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
For recorded status without a provider probe, use armada status instead.
Example: armada detail SANDBOX_UUID --org ORG_UUID --json
`,
  wait: `Usage: armada wait <sandbox-id> [--timeout <seconds>] [--org UUID] [--json]
Wait for sandbox activity through the server after Armada login and authorization.
Timeout is an integer from 0 to 600 seconds (default 60); zero is accepted.
Use a sandbox ID from armada list --json. Output is JSON even without --json.
Inspect the returned state; a bounded wait is not proof that your task is complete.
Example: armada wait SANDBOX_UUID --timeout 60 --org ORG_UUID --json
`,
  stop: `Usage: armada stop <sandbox-id> [--org UUID] [--json]
Stop the machine after Armada login and server authorization, not just the running turn.
Modal retains its disk only if checkpoint succeeds; fallback termination cannot resume.
Inspect the returned status/preservation note; do not assume disk retention.
After an uncertain outcome, inspect status/list before retrying. This is not permanent rm deletion.
Output is JSON even without --json.
Example: armada stop SANDBOX_UUID --org ORG_UUID --json
`,
  interrupt: `Usage: armada interrupt <sandbox-id> [--conversation <id>] [--org UUID] [--json]
Interrupt the running turn of one conversation, or all, after Armada login and authorization.
The sandbox stays up for the next send. This does not stop or delete the machine.
Availability depends on the provider/harness; the server can refuse unsupported interruption.
Output is JSON even without --json.
Example: armada interrupt SANDBOX_UUID --org ORG_UUID --json
`,
  send: `Usage: armada send <sandbox-id> <text> [--conversation <id>] [--model <id>] [--reasoning-effort <level>]
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
  steer: `Usage: armada steer <sandbox-id> <text> [--conversation <id>] [--org UUID] [--json]
Redirect a currently running turn after Armada login and server authorization.
Refused when no turn is running; use send for a new turn.
Delivery may join the turn natively or interrupt/restart the same conversation;
inspect the returned delivery field. Output is JSON even without --json.
Put options before -- to pass literal option-like text.
Example: armada steer SANDBOX_UUID --org ORG_UUID -- "Focus on the failing test"
`,
  exec: `Usage: armada exec <sandbox-id> <command> [--cwd <path>] [--timeout <seconds>] [--org UUID] [--json]
Run a shell command after Armada login and server authorization; not an agent prompt.
Default cwd is /home/user. Timeout is integer seconds 1–600 (default 120).
Output is JSON with command exitCode, stdout/stderr and timeout/truncation information.
Inspect exitCode and timedOut; a successful CLI request is not proof the shell command succeeded.
Put options before -- so command flags are passed literally, not parsed as Armada options.
Example: armada exec SANDBOX_UUID --org ORG_UUID -- "git status --short"
`,
  list: `Usage: armada list [--status <status>] [--agent <harness> | --harness <harness>]
  [--golden UUID] [--owner UUID|me] [--page <N>] [--limit <N>] [--org UUID] [--json] [--page-info]
List visible sandboxes after Armada login and server authorization.
Status: starting, ready, running, stopping, stopped, failed or deleted.
Deleted sandboxes are excluded by default; request --status deleted to include them.
--agent and --harness are aliases; use only one (claude, codex or opencode).
--golden filters by snapshot UUID. --owner accepts a user UUID or me.
Page is 1–1000000; limit is 1–200 (default page size 25). This is one page, not all results.
Human output is a table. --json returns {sandboxes:[...]}; --page-info returns full
page metadata and exact totals as JSON even without --json.
Use --org to override a saved selection. Reuse returned IDs with status/logs/send.
Example: armada list --owner me --page 1 --limit 25 --json
Example: armada list --org ORG_UUID --page 2 --page-info
`,
  advice: `Usage: armada advice <sandbox-id> [--org UUID] [--json]
Read resource-sizing advice after Armada login and server authorization.
Collects one bounded sample and considers up to the last 10 comparable sessions.
Missing or partial evidence can produce no recommendation; do not treat unknowns as measured headroom.
This never resizes a running machine or changes defaults; recommendations concern future launches.
Human output summarizes supported advice or the no-recommendation reason.
Use --json to inspect the full evidence response. Use a sandbox ID from armada list.
Example: armada advice SANDBOX_UUID --org ORG_UUID --json
`,
  report: `Usage: armada report <sandbox-id> ready|blocked --prompt-id <id> [--org UUID] [--json]
  ready: [--pr-number <N>] [--pr-url <URL>] [--head-sha <SHA>]
  blocked: --reason <text>
Report an explicit outcome for the latest finished turn after Armada login.
Only the sandbox owner or current organization admin may report.
Call after wait; use the latest finished prompt ID, not an arbitrary earlier turn.
A new send clears the outcome. Message text alone is not a reported outcome.
Blocked requires a nonempty reason (maximum 1000 characters).
Ready accepts optional PR metadata; the report itself does not verify CI or merge a PR.
Output is JSON even without --json.
Example: armada report SANDBOX_UUID blocked --prompt-id PROMPT_ID --reason "Need owner input"
Example: armada report SANDBOX_UUID ready --prompt-id PROMPT_ID --pr-number 123
`,
  "snapshot retirement dry-run": `Usage: armada snapshot retirement dry-run <snapshot-UUID> [--limit <1-50>] [--org UUID] [--json]
Review bounded historical snapshot retirement candidates after Armada login.
Requires server owner/admin authorization. Limit defaults to 20; output is always JSON.
Use the snapshot record UUID, not a sandbox ID or provider artifact ID.
Review the results and receipts before using retirement reconcile. No provider mutation in this review.
Example: armada snapshot retirement dry-run SNAPSHOT_UUID --org ORG_UUID --limit 20
`,
  "snapshot retirement reconcile": `Usage: armada snapshot retirement reconcile <snapshot-UUID> [--file <path>] [--limit <1-50>] [--org UUID] [--json]
Reconcile reviewed history and enqueue eligible retirement work after Armada login and authorization.
Supply reviewed dry-run JSON via stdin or --file; do not invent receipts.
The JSON must contain 1–50 valid receipts in results. Limit defaults to 20.
Omit --file for stdin; --file - is not the stdin spelling for this command.
Server rechecks authority, history and references; eligible work is queued, not proof of deletion.
Output is always JSON. Use the snapshot record UUID, not a provider artifact ID.
Example: armada snapshot retirement reconcile SNAPSHOT_UUID --org ORG_UUID --file reviewed.json
`,
  login: `Usage: armada login [--email <address> | --provider github|google] [--url <server-origin>]
Sign in to Armada, not directly to a sandbox provider.
Use --email for email code/link sign-in; --provider chooses an enabled browser method.
Do not combine --email and --provider. Without either, discover enabled server methods.
Server selection: --url, then ARMADA_URL, then the default Armada API origin.
Global --profile NAME (or ARMADA_PROFILE) isolates saved login and preferences;
use login --url to configure a new profile's server.
Keep the terminal open while completing sign-in. Use an interactive terminal for email code entry.
ARMADA_TOKEN supplies service-token authentication to API commands; a saved login
does not unset that environment variable. Keep tokens in a secure environment, never arguments.
Example: armada login --email you@example.com
Example: armada --profile staging login --url https://staging.example.com --provider github
`,
  snapshot: `Usage: armada snapshot <command> [arguments]
Manage provider-scoped snapshots. Use a leaf command with --help or -h for syntax.
Boat/Modal:
  create       Build a snapshot from repositories/config.
  update       Append repositories or explicitly replace the complete config.
  build-find   Find an active build by name.
  build-status Inspect a job or recover admission using its saved key.
  build-cancel Cancel your queued, never-started build.
  connect      Prepare the canonical master for maintenance.
  snapshot     Scan and freeze the maintained master.
  capabilities Read server-authoritative capacity.
  size-policy  Inspect or replace future-launch size defaults.
  remove       Remove from launch selection, retaining children/provider artifacts.
  visibility   Change visibility using the snapshot record ID.
  retirement dry-run|reconcile  Review history and reconcile reviewed receipts.
Docker:
  create       Build a host-local snapshot (--provider docker, host/org required).
  get          Read saved build state.
  rebuild      Build a new snapshot on the original host, keeping the old one.
Shared:
  list         List visible snapshots; Docker requires an organization UUID.
Operations require Armada login and server authorization; help does not.
The legacy golden spelling is accepted; guidance uses snapshot.
Example: armada snapshot list --provider modal --json
Example: armada snapshot create --help
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
  creds: `Usage: armada creds <command> [arguments]
Manage encrypted model/provider credentials, not application variables/secrets.
Use a leaf command with --help or -h for its flags and secure input instructions.
Native subscription accounts:
  login codex  Authorize native Codex in your browser; keep the terminal open.
  import       Import an existing Claude token or Codex auth JSON securely.
API connections:
  presets      List built-in provider choices without login.
  connect      Store a named API connection using a preset.
  set          Store a supported credential kind or custom endpoint.
  test         Test a sandbox's bound model connection; may incur a provider charge.
Account metadata:
  list         List metadata/IDs, never credential values.
  rename       Rename by account ID.
  default      Select a default account by ID.
  remove       Remove an account by ID.
  rm           Legacy kind-scoped removal; not an alias for remove <id>.
Native subscriptions require eligible subscription access; API keys use provider billing.
Read secret inputs from stdin/hidden input or private files, never command arguments.
For application environment values use vars or secrets instead. Server authorization still applies.
Example: armada creds presets --json
Example: armada creds import --help
`,
  "creds login": `Usage: armada creds login codex (--name <name> | --id <id> --expected-version <version>) [--org <name>]
Start native Codex device login after Armada login. Keep this terminal open until publishing finishes.
For Claude, run claude setup-token locally, then use armada creds import claude.
Example: armada creds login codex --name personal
`,
  "creds login codex": `Usage: armada creds login codex (--name <name> | --id <id> --expected-version <version>) [--org <name>]
Requires a ChatGPT subscription with Codex access and an Armada login.
Approve the native device login in your browser; keep this terminal open until publishing finishes.
Use --name to create an account; replacement requires --id and a positive integer --expected-version.
Omit --org for personal scope; pass it for organization scope.
Example: armada creds login codex --name personal
`,
  "creds list": `Usage: armada creds list [--org <name>] [--json]
List credential metadata after Armada login; secret values are never returned.
Use --json to obtain account IDs for rename, default and remove.
Example: armada creds list --json
`,
  "creds rename": `Usage: armada creds rename <id> <name> [--org <name>] [--json]
Rename a credential account after Armada login and server authorization.
Use an account ID from armada creds list --json. Output is JSON even without --json.
Omit --org for your personal account; pass it for an organization account.
Example: armada creds rename ACCOUNT_UUID personal-api
`,
  "creds default": `Usage: armada creds default <id> [--org <name>] [--json]
Select a default credential account after Armada login and server authorization.
Use an account ID from armada creds list --json. Output is JSON even without --json.
Omit --org for your personal account; pass it for an organization account.
Example: armada creds default ACCOUNT_UUID
`,
  "creds remove": `Usage: armada creds remove <id> [--org <name>] [--json]
Remove a credential account by ID after Armada login and server authorization.
Use an account ID from armada creds list --json. Output is JSON even without --json.
Omit --org for your personal account; pass it for an organization account.
This is not creds rm, which takes a credential kind rather than an account ID.
Example: armada creds remove ACCOUNT_UUID
`,
  "creds rm": `Usage: armada creds rm <kind> [--org <name>] [--json]
Remove a legacy kind-scoped credential after Armada login and server authorization.
Omit --org for personal scope; pass it for organization scope.
This is not an alias for creds remove <id>; use remove for a named account ID.
Example: armada creds rm openai
`,
  "creds presets": `Usage: armada creds presets [--json]
List built-in connection presets and their harness/model/address requirements.
No login or provider call is needed. Use a preset ID with armada creds connect.
Example: armada creds presets --json
`,
  "creds connect": `Usage: armada creds connect <preset> --name <name> [--file <path>] [--org <name>] [--json]
  [--models <id,...>] [--base-url <HTTPS-url>] [--api-version <version>]
Store a named connection after Armada login. Choose a preset with armada creds presets --json.
Supply only the API key through stdin/hidden input or a private --file, never command arguments or JSON.
Presets with harness models reject --models, --base-url and --api-version.
Chosen-model presets require --models and, unless fixed by the preset, --base-url.
Fixed-address presets reject --base-url; --api-version is only accepted by supporting presets.
Official Azure addresses are tested with a tiny billable request per deployment before saving;
a failed check saves nothing. Omit --org for personal scope.
Morph: armada creds connect morph --name shared --file /private/morph-key
One account supports Claude Code and Codex. At launch choose --credential-id ACCOUNT_UUID
and --model morph-kimik31, morph-dsv41flash or morph-dsv41flash-1017.
Example: armada creds connect openai --name personal --file /private/api-key
`,
  "creds test": `Usage: armada creds test <sandbox-id> --model <deployment-model> [--org <name>] [--json]
Test a sandbox's bound model connection after Armada login and server authorization.
This can make a billable provider request. No keys or URLs are accepted as arguments.
A successful check is not a full harness compatibility test. Failure exits 1.
Example: armada creds test SANDBOX_UUID --model deployment-name --json
`,
  "creds set": `Usage: armada creds set <kind> [--name <name>] [--org <name>] [--file <path>]
Store an encrypted credential after armada login. Read the secret from hidden input,
stdin or a private file, never command arguments. API keys use provider billing;
subscription credentials require an eligible subscription, not an API key.
Example: armada creds set openai --name personal --file /private/openai-key
`,
  "snapshot create": `Usage: armada snapshot create <name> (--repo <url>[@branch] ... | --config <file>)
  [--init <command> ...] [--setup <local-file>] [--provider boat|modal]
  [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>] [--json]
Docker: armada snapshot create <name> --provider docker --host UUID|NAME --org UUID
  (--config <file> | --repo <url>[@branch] ... [--init <command> ...])
  [--private] [--request-id UUID] [--json]
--config cannot be combined with --repo or --init; include init commands in the JSON file.
Docker builds a host-local snapshot; --setup and durable-job flags above are Boat/Modal only.
Boat/Modal --timeout defaults to 60 seconds (0 returns after admission, maximum 600).
Save --idempotency-key to recover uncertain admission with snapshot build-status.
Requires Armada login, a connected provider and GitHub repository authorization.
Builds, scans and snapshots on the server; do not include secrets in setup.
Example: armada snapshot create starter --provider modal --repo https://github.com/octocat/Hello-World --org my-team
`,
  "snapshot update": `Usage: armada snapshot update <name> (--add-repo <url>[@branch] ... | --replace --repo <url>[@branch] ... | --replace --config <file>)
  [--init <command> ...] [--setup <local-file>] [--provider boat|modal]
  [--org <org>] [--idempotency-key <key>] [--timeout <seconds>] [--json]
--config cannot be combined with --repo or --init; include init commands in the JSON file.
Rebuild a snapshot in place after Armada login; ownership and visibility stay unchanged.
Use --add-repo to append while preserving stored repositories and init commands.
Do not combine --add-repo with --replace, --repo, --config, --init or --setup.
--replace replaces the ENTIRE config; include every repository and init command to keep.
--setup reads a local script. Never include secrets in setup or snapshot contents.
--timeout defaults to 60 seconds (0 returns after admission, maximum 600).
Disconnecting does not cancel or resubmit; inspect snapshot build-status before retrying.
Docker update is not supported; use snapshot rebuild for a new Docker snapshot.
Example: armada snapshot update starter --add-repo https://github.com/octocat/Hello-World --provider modal --org my-team
`,
  "snapshot build-find": `Usage: armada snapshot build-find <name> [--provider boat|modal] [--org <org>] [--json]
Find the latest visible active build when you have no job ID or admission key.
Requires Armada login. No match does not rule out a reservation needing administrator investigation.
Example: armada snapshot build-find starter --provider modal --json
`,
  "snapshot build-status": `Usage: armada snapshot build-status <job-id> [--org <org>] [--json]
   or: armada snapshot build-status --idempotency-key <key> --org <org> [--json]
Read durable build status, or recover uncertain admission using its saved key.
Requires Armada login. Output is JSON; failed or recovery-required builds exit 1.
Example: armada snapshot build-status --idempotency-key saved-build-key --org my-team
`,
  "snapshot build-cancel": `Usage: armada snapshot build-cancel <job-id> [--org <org>] [--json]
Cancel your queued, never-started build. Requires Armada login.
Started builds cannot be cancelled with this command. Inspect status before retrying an uncertain operation.
Example: armada snapshot build-cancel build-id --org my-team
`,
  "snapshot list": `Usage: armada snapshot list [--provider boat|modal|docker] [--org <org>] [--json]
List snapshots visible to you after Armada login; use --provider to filter.
Docker snapshots require --org UUID.
Use --json for structured output and reusable snapshot IDs.
Example: armada snapshot list --provider modal --org my-team --json
`,
  "snapshot capabilities": `Usage: armada snapshot capabilities [--provider boat|modal] [--org <org>] [--json]
Read server-authoritative snapshot capacity after Armada login.
A null maximum means unbounded or unknown, not zero available snapshots.
Docker is not supported by this command.
Example: armada snapshot capabilities --provider modal --org my-team --json
`,
  "snapshot connect": `Usage: armada snapshot connect <name> [--provider boat|modal] [--org <org>] [--json]
Prepare the canonical master sandbox for maintenance after Armada login.
Prints the sandbox ID and a web URL when available; does not open your browser.
Example: armada snapshot connect starter --provider modal --org my-team
`,
  "snapshot snapshot": `Usage: armada snapshot snapshot <name> [--provider boat|modal] [--org <org>] [--json]
Scan and freeze the canonical master after maintenance. Requires Armada login.
Do not leave secrets in the master; the server scans before saving.
Example: armada snapshot snapshot starter --provider modal --org my-team
`,
  "snapshot remove": `Usage: armada snapshot remove <name-or-id> [--provider boat|modal] [--org <org>] [--json]
Remove a snapshot after Armada login and server authorization.
Names must identify one visible snapshot. Disambiguate with --provider and --org,
or use the exact ID from armada snapshot list --json.
Example: armada snapshot remove starter --provider modal --org my-team
`,
  "snapshot visibility": `Usage: armada snapshot visibility <id> --visibility private|org [--org <org>] [--json]
Change snapshot visibility after Armada login and server authorization.
Use the snapshot ID from armada snapshot list --json, not its display name.
Example: armada snapshot visibility SNAPSHOT_UUID --visibility private --org my-team
`,
  "snapshot get": `Usage: armada snapshot get <snapshot-UUID> --provider docker --org UUID [--json]
Inspect a Docker snapshot's saved build state after Armada login.
Get the snapshot ID from armada snapshot list --provider docker --org UUID --json.
Output is JSON even without --json. Boat/Modal do not support this command.
Example: armada snapshot get SNAPSHOT_UUID --provider docker --org ORG_UUID
`,
  "snapshot rebuild": `Usage: armada snapshot rebuild <snapshot-UUID> --provider docker --org UUID [--request-id UUID] [--json]
Build a new Docker snapshot from saved repositories/setup on its original host.
Requires Armada login and server authorization; the old snapshot stays unchanged.
A request ID is generated if omitted and printed to stderr before submission.
After an unknown outcome, inspect that ID; retry with the same --request-id.
Use a request UUID different from the original snapshot UUID.
Example: armada snapshot rebuild SNAPSHOT_UUID --provider docker --org ORG_UUID --request-id NEW_UUID
`,
  "snapshot size-policy": `Usage: armada snapshot size-policy <name> [--provider boat|modal] [--org <org>] [--file <JSON|->] [--json]
Inspect snapshot machine-size defaults, or replace them with a versioned JSON object.
Requires Armada login; changes affect future launches only, not existing machines.
Omit --file to inspect. Use --file - to read replacement JSON from stdin.
Replacement is complete, not a patch: include every default you want to keep.
Output is JSON, including the version and configured repository selectors.
Example: armada snapshot size-policy starter --provider modal --org my-team
Example: armada snapshot size-policy starter --provider modal --file policy.json
`,
  "host list": `Usage: armada host list [--org UUID] [--json]
List registered Docker hosts after Armada login and server authorization.
Select an organization first or pass --org UUID. Use IDs/names with host show.
Example: armada host list --org ORG_UUID --json
`,
  "host show": `Usage: armada host show <UUID|name> [--org UUID] [--json]
Inspect one Docker host after Armada login and server authorization.
Select an organization first or pass --org UUID. Names must match exactly and be unambiguous.
A UUID can identify a revoked host; name lookup excludes revoked hosts.
Example: armada host show workstation --org ORG_UUID --json
`,
  "host limits": `Usage: armada host limits <UUID|name> [--org UUID]
  [--cpus <N>] [--memory <size>] [--max-sandboxes <N>] [--auto]
Update Docker host policy after Armada login and server authorization.
Select an organization first or pass --org UUID. Supply at least one override or --auto.
Combine overrides as needed:
--cpus must be at least 0.01; --max-sandboxes must be a positive integer.
--auto resets all limits and cannot be combined with overrides.
Container changes apply on the next start or resume. Inspect with host show.
Example: armada host limits workstation --org ORG_UUID --cpus 2 --memory 4GiB
`,
  "host revoke": `Usage: armada host revoke <UUID> [--org UUID]
Revoke a Docker host after Armada login and server authorization.
Select an organization first or pass --org UUID. Use a host UUID from host list, not a name.
Example: armada host revoke HOST_UUID --org ORG_UUID
`,
  "host add": `Usage: armada host add [--name <name>] [--org <UUID>]
Register your Docker machine after Armada login. Select an organization first or pass --org.
Run the returned installer only on your intended host; its registration token is short-lived.
Example: armada host add --name workstation
`,
};

function importHelp(harness?: string): string {
  return `Usage: armada creds import ${harness ?? "claude|codex"} (--name <name> | --id <id> --expected-version <version>) [--file <path>] [--org <name>]
Import an existing native credential after Armada login; no native login is started.
Claude: run claude setup-token locally. Codex: supply native auth JSON.
Read the credential from stdin/hidden input or a private --file, never command arguments.
Use --name to create; replacement requires --id and a positive integer --expected-version.
Omit --org for personal scope; pass it for organization scope.
Credentials are stored encrypted; allowance information may be unavailable.
Example: armada creds import ${harness ?? "claude"} --name personal --file /private/native-credential
`;
}

function githubAuthorizationHelp(action: "connect" | "reconnect" | "install"): string {
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

function mcpAuthorizationHelp(action: "connect" | "reconnect"): string {
  return `Usage: armada mcp ${action} <connection-id> [--org UUID] [--no-browser] [--timeout <seconds>] [--json]
${action === "reconnect" ? "Revoke existing authorization first, then start a new connection authorization." : "Start authorization for an existing MCP registry connection."}
Requires Armada login and server authorization. Select an organization with armada org use or --org UUID.
Use a connection ID from mcp list, not a sandbox ID.
Opens a server-issued authorization URL when supplied; --no-browser prints it to stderr.
--timeout is an integer from 0 to 600 seconds (default 300).
Zero still starts authorization and checks status; a URL alone is not success.
On timeout, inspect mcp status before retrying. Successful output is always JSON.
Example: armada mcp ${action} CONNECTION_UUID --org ORG_UUID --no-browser --timeout 300
`;
}

function completionHelp(shell?: "bash" | "zsh" | "fish"): string {
  return `Usage: armada completion ${shell ?? "bash|zsh|fish"}
Print a shell-completion script to stdout. No login or network request is needed.
Choose the shell you actually use; inspect the generated script before sourcing it.
This command does not install completion or modify your shell configuration.
Example: armada completion ${shell ?? "bash"} > armada-completion.${shell ?? "bash"}
`;
}

export function onboardingHelp(argv: readonly string[]): string | undefined {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const parts = argv.slice(0, -1);
  // Keep the legacy spelling usable without changing literal arguments.
  if (
    parts[0] === "golden" &&
    [
      "retirement",
      "create",
      "update",
      "get",
      "rebuild",
      "size-policy",
      "build-find",
      "build-status",
      "build-cancel",
      "list",
      "capabilities",
      "connect",
      "snapshot",
      "remove",
      "visibility",
    ].includes(parts[1] ?? "")
  )
    parts[0] = "snapshot";
  if (parts.length === 1 && parts[0] === "golden") parts[0] = "snapshot";
  const command = parts.join(" ");
  if (command === "completion") return completionHelp();
  if (command === "completion bash") return completionHelp("bash");
  if (command === "completion zsh") return completionHelp("zsh");
  if (command === "completion fish") return completionHelp("fish");
  if (command === "mcp connect") return mcpAuthorizationHelp("connect");
  if (command === "mcp reconnect") return mcpAuthorizationHelp("reconnect");
  if (command === "github connect") return githubAuthorizationHelp("connect");
  if (command === "github reconnect") return githubAuthorizationHelp("reconnect");
  if (command === "github install") return githubAuthorizationHelp("install");
  if (command === "creds import") return importHelp();
  if (command === "creds import claude") return importHelp("claude");
  if (command === "creds import codex") return importHelp("codex");
  return Object.hasOwn(HELP, command) ? HELP[command] : undefined;
}
