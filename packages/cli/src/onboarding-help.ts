import type { Command } from "./commands/command.ts";
import { commands, findCommand } from "./commands/index.ts";

// Exact command boundaries only: never interpret payload or remote arguments as help.
const HELP: Record<string, string> = {
  "vars list": `Usage: armada vars list [--org NAME|UUID] [--json]
List readable application-variable metadata, not values or model credentials.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Includes your personal entries and visible organization entries. Use IDs from this list
with vars read; names are not accepted as read selectors.
Human output is compact metadata; --json emits {items:[...]} with safe scalar metadata only.
Readable variables are not secrets. Use secrets for sensitive application values.
Example: armada vars list --org ORG_UUID --json
`,
  "vars read": `Usage: armada vars read ID [--org NAME|UUID] [--json]
Read an application-variable value by ID from vars list, not by name.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Your personal entries and authorized organization entries are readable; variables are not secrets.
Default stdout is the value exactly, without adding a newline. --json emits
{item: metadata, value: string} followed by a newline. Take care when sharing or piping values.
This does not read an application secret, export model credentials or deliver values to a sandbox.
Example: armada vars read VARIABLE_UUID --org ORG_UUID --json
`,
  "secrets list": `Usage: armada secrets list [--org NAME|UUID] [--json]
List application-secret metadata, never secret values or model credentials.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Includes your personal entries and visible organization entries. IDs and versions are used
by guarded rotate/revoke/delete operations; list itself makes no changes.
Human output is compact metadata; --json emits {items:[...]} with safe scalar metadata only.
Secrets have no read, reveal or export operation. Use vars read only for readable variables.
Example: armada secrets list --org ORG_UUID --json
`,
  routine: `Usage: armada routine <command> [arguments]
Manage scheduled template launches that run as the routine owner.

  create  Create a paused routine from file or inline configuration.
  list    List visible IDs, names, status, versions and next occurrences.
  show    Inspect configuration, prompt and current version.
  update  Replace configuration from file, or change only the inline schedule.
  enable  Schedule the next occurrence, not an immediate manual launch.
  pause   Stop new admissions; already admitted runs may finish.
  delete  Mark deleted; does not stop or delete running sandboxes.
  runs    Read the latest 100 decisions and original-prompt outcomes.

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Organization-scoped writes require administrator permission.
Use IDs from routine list when exact names collide; keep IDs for history after deletion.
Updates and state changes require --expected-version from routine show/list;
conflicts are not retried automatically. Prompts are readable configuration, not secrets.
Schedules use five-field cron and IANA time zones, with runs at least one hour apart.
Launch success is not task success; unknown is not success. Inspect routine runs.
Inspect a command's options with armada routine <command> --help.
Example: armada routine list --org ORG_UUID --json
Example: armada routine runs ROUTINE_UUID --org ORG_UUID --json
`,
  template: `Usage: armada template <command> [arguments]
Manage reusable launch definitions and their immutable template versions.

  create   Create a template from a JSON definition file or definition flags.
  list     List visible IDs, names, scopes, status and current versions.
  get      Inspect metadata or a selected version's definition with --json.
  publish  Publish a complete new version, guarded by --expected-revision.
  delete   Mark a template deleted, guarded by --expected-revision.
  launch   Launch a template version using a saved --request-key for safe retries.

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Templates may be personal or organization-scoped;
organization-scoped writes require administrator permission.
Use IDs from template list when exact names collide across scopes.
Definitions store variable/secret references; do not put raw secret values in them.
References resolve into frozen manifests at launch, not publication.
After an unknown launch outcome, keep the same request key and body; do not start
a new attempt. See template launch --help for resolved-ID recovery.
Inspect a command's full options with armada template <command> --help.
Example: armada template list --org ORG_UUID --json
Example: armada template get TEMPLATE_UUID --revision 1 --org ORG_UUID --json
`,
  "routine list": `Usage: armada routine list [--org NAME|UUID] [--json]
List visible scheduled template launches: IDs, names, scopes, status and versions.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Human output includes the schedule and next due time; paused routines have no next run.
--json emits the API response with an items array. Use IDs when exact names are ambiguous.
Use routine show for configuration and routine runs for admission/task outcomes.
Example: armada routine list --org ORG_UUID --json
`,
  "routine show": `Usage: armada routine show NAME|ID [--org NAME|UUID] [--json]
Inspect a scheduled template launch, including its version, schedule and prompt.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one non-deleted routine; use an ID from routine list
if names collide. Copy the current version before guarded updates or status changes.
Human output includes template version, TTL, daily cap, failures, pause reason and prompt.
Prompts are readable configuration, not a place for secrets; take care when sharing output.
--json emits the API response with item. This reads configuration, not run history.
Example: armada routine show ROUTINE_UUID --org ORG_UUID --json
`,
  "routine runs": `Usage: armada routine runs NAME|ID [--org NAME|UUID] [--json]
Read the latest 100 routine decisions and original-prompt outcomes.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one non-deleted routine. Use a routine ID from
routine list if names collide; use the ID to inspect history after deletion.
Human output includes scheduled time, admission state, task outcome, readable skip/failure
reasons and a sandbox ID when available. Launch success is not task success;
unknown or not observed is not success. --json emits the API response with an items array.
This does not trigger a scheduled run, wait for completion or stream sandbox logs.
Example: armada routine runs ROUTINE_UUID --org ORG_UUID --json
`,
  "template launch": `Usage: armada template launch NAME|ID --request-key KEY [--revision N] [options]
Launch an existing template, resolving its references into a frozen launch manifest.
Requires Armada login or ARMADA_TOKEN; select an organization with --org NAME|UUID
or armada org use. Find template IDs and current versions with template list/get.
Names must match exactly and identify one active template; use an ID if names collide.

Options:
  --revision N                           Positive version number; omission uses current.
  --prompt TEXT                          Override the launch prompt.
  --ttl <duration>                       Override lifetime, for example 30m.
  --size small|medium|large|xlarge        Override machine size.
  --repo REPO                            Override the initial repository.
  --model-account UUID                   Select an unpinned model account.
  --model-account-version N              Required with --model-account; positive integer.
  --org NAME|UUID                        Organization selector.
  --json                                 Accepted; launch always emits JSON on stdout.
A template version's pinned model account cannot be overridden. No inline environment values
or local environment expansion are supported; definitions hold variable/secret references.

--request-key is required: 1–128 ASCII letters, digits, dots, underscores, colons or hyphens.
Save the key before submission. After an unknown outcome, retry the SAME key and body,
including organization, template version and overrides; never invent a new key for that attempt.
Name-based launch prints the resolved template ID to stderr before submission. Use that ID
for recovery, so a later rename or deletion cannot prevent the original request's replay.
Example: armada template launch TEMPLATE_UUID --request-key audit_run_1 --revision 2 --org ORG_UUID --json
`,
  "template delete": `Usage: armada template delete NAME|ID --expected-revision N [--org NAME|UUID] [--json]
Mark a launch template deleted; this command is not sandbox deletion.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
An organization-scoped template requires administrator permission.
Names must match exactly and identify one active template. Use an ID from template list
when names collide across scopes.
--expected-revision is required and must be a positive integer. Copy the current version
from template get or template list; a stale version is refused, not retried automatically.
On a conflict, inspect the template again before deciding whether to delete the newer version.
Human output shows template metadata and deleted status; --json emits the API response with item.
Example: armada template delete TEMPLATE_UUID --expected-revision 2 --org ORG_UUID --json
`,
  "template list": `Usage: armada template list [--org NAME|UUID] [--json]
List visible launch-template metadata: IDs, names, scope, status and current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Use a template ID from this list when names collide across scopes.
--json emits the API response with an items array; human output is a compact table.
Use armada template get ID --json to inspect a definition, not list.
Example: armada template list --org ORG_UUID --json
`,
  "template get": `Usage: armada template get NAME|ID [--revision N] [--org NAME|UUID] [--json]
Inspect a visible launch template; omitted --revision selects its current version.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Names must match exactly and identify one active template; use an ID from template list
when names collide across scopes. --revision is a positive integer.
Human output shows metadata and the selected version, not the definition.
--json emits the API response including item and revision with its definition.
Definitions contain references to variables and secrets, not raw secret values.
This reads a template; it does not publish, launch or resolve a frozen launch manifest.
Example: armada template get TEMPLATE_UUID --revision 1 --org ORG_UUID --json
`,
  github: `Usage: armada github <command> [arguments]
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
  mcp: `Usage: armada mcp <command> [arguments]
Manage MCP registry connections and inspect sandbox bindings.
Use leaf --help/-h for exact flags. Operations require Armada login, server
authorization and organization selection with org use or --org UUID.
Registry:
  catalog  Read service metadata.
  list     List visible connections and IDs.
  add      Create by service, public URL or JSON definition.
  update   Update from a JSON definition; scope cannot change.
  rename   Rename a connection by ID.
  default  Set launch-default selection with positional on|off.
  enable   Enable the registry entry; check status for authorization state.
  disable  Disable without deleting the registry entry.
  delete   Delete the registry entry.
Authorization:
  status     Read a connection's status.
  connect    Authorize an existing connection.
  reconnect  Revoke first, then start authorization again.
  revoke     Revoke authorization, not registry deletion.
Sandbox:
  sandbox-connections  Read actual bound metadata using a sandbox UUID.
Registry IDs and sandbox UUIDs are different selectors. Help does not call MCP.
Keep authentication values in private files/stdin, never command arguments.
Example: armada mcp list --org ORG_UUID --json
Example: armada mcp add --help
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
  "bind-credential": `Usage: armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
Owner-only legacy Modal credential-binding recovery after Armada login.
Stop the sandbox safely before rebinding; this command does not restart it.
Use a sandbox ID from armada list and a credential-account UUID from creds list.
Do not pass secret credential values. Output is JSON even without --json.
Example: armada bind-credential SANDBOX_UUID --credential-id ACCOUNT_UUID --org ORG_UUID
`,
  "snapshot retirement": `Usage: armada snapshot retirement dry-run|reconcile <snapshot-UUID> [options]
Review historical candidates with dry-run; apply reviewed receipts with reconcile.
Use each subcommand with --help for exact flags.
Example: armada snapshot retirement dry-run SNAPSHOT_UUID --json
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
  snapshot: `Usage: armada snapshot <command> [arguments]
Manage provider-scoped snapshots. Use a leaf command with --help or -h for syntax.
Boat/Modal:
  create       Build a snapshot from repositories/config.
  update       Append repositories or explicitly replace the complete config.
  build-find   Find an active build by name.
  build-status Inspect a job or recover admission using its saved key.
  build-cancel Cancel your queued, never-started build.
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
  [--max-agents <positive-integer> | --unlimited]
Store a named connection after Armada login. Choose a preset with armada creds presets --json.
Supply only the API key through stdin/hidden input or a private --file, never command arguments or JSON.
Presets with harness models reject --models, --base-url and --api-version.
Chosen-model presets require --models and, unless fixed by the preset, --base-url.
Fixed-address presets reject --base-url; --api-version is only accepted by supporting presets.
Official Azure addresses are tested with a tiny billable request per deployment before saving;
a failed check saves nothing. Omit --org for personal scope.
Morph defaults to 2 simultaneous agents; other accounts default to unlimited.
Use --max-agents N or --unlimited on connect, import, login and set.
Change an existing cap with armada creds limits ACCOUNT_UUID --max-agents 2 or --unlimited.
Morph: armada creds connect morph --name shared --file /private/morph-key
Use Claude Code, Codex or OpenCode on Modal, Docker or runtime-backed Boat.
At launch choose --credential-id ACCOUNT_UUID and a Morph plan model with --model.
Example: armada creds connect openai --name personal --file /private/api-key
`,
  "creds limits": `Usage: armada creds limits <account-id> [--model <model-id>] --max-agents N | --unlimited [--org <name>] [--json]
Set the maximum agents running at the same time across sandbox providers.
With --model, set that exact launch model ID instead; --unlimited clears its override.
Accounts without a model override use only their account-wide cap.
creds list --json exposes modelLimits and modelCounts.
Stopped and idle-paused sandboxes do not count. New starts beyond the cap are refused before allocation.
Existing running agents are not stopped when lowering the cap.
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

function templateDefinitionHelp(action: "create" | "publish"): string {
  const creating = action === "create";
  return `Usage: armada template ${action} ${creating ? "NAME" : "NAME|ID --expected-revision N"} [definition input] [--org NAME|UUID] [--json]
${creating ? "Create a launch template with its first immutable version." : "Publish a new immutable version of an existing launch template, not a partial patch."}
Requires Armada login or ARMADA_TOKEN. Select an organization with --org or armada org use.
${creating ? "--scope personal|org selects visibility; with explicit --org it is required.\nWithout explicit --org, scope defaults to personal in the selected organization." : "Names must match exactly and identify one active template; use an ID from template list\nif names collide. The target keeps its existing scope.\n--expected-revision is a required positive integer from template get/list.\nA stale version is refused; inspect the current definition before deciding to republish."}
Organization-scoped writes require administrator permission.

Choose ONE complete definition input (file and definition flags cannot be mixed):
  --file definition.json                 Definition object, not an API envelope.
  --golden UUID --provider boat|modal --agent claude|codex|opencode
  --host UUID --provider docker --agent claude|codex|opencode
--golden is the existing snapshot selector. Docker --host requires a UUID, not a name;
it selects the official environment, not a host-local snapshot. Boat supports Claude/Codex.

Optional definition flags (not combined with --file):
  --model ID --reasoning-effort LEVEL
  --connection UUID                      Repeat for multiple MCP connections.
  --variable KEY:UUID:VERSION            Repeat for readable variable references.
  --secret KEY:UUID:VERSION              Repeat for secret references, never raw values.
  --skill PIN                           Repeat for multiple skills.
  --model-account UUID --model-account-version N   Pin an account and positive version.
No local environment expansion. Frozen launch manifests are resolved at launch, not publication.
Readable values can appear in launch manifests; do not use variables for secrets.
Human output shows metadata and current revision; --json emits the API response.
Example: armada template ${action} ${creating ? "nightly --scope personal" : "TEMPLATE_UUID --expected-revision 2"} --file definition.json --org ORG_UUID --json
`;
}

function routineStateHelp(action: "enable" | "pause" | "delete"): string {
  const effect = {
    enable:
      "Enable scheduled launches as the routine owner. Selects the next occurrence, not an immediate manual launch.\nThe owner must still be eligible and the pinned template revision must be available.",
    pause:
      "Pause new launch admissions; already admitted runs may finish and running sandboxes are not stopped.\nUse routine enable with a fresh version to schedule future occurrences again.",
    delete:
      "Mark a routine deleted and stop new admissions; already admitted runs may finish.\nThis does not stop or delete running sandboxes. Keep the routine ID for routine runs history.",
  }[action];
  return `Usage: armada routine ${action} NAME|ID --expected-version N [--org NAME|UUID] [--json]
${effect}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Organization-scoped changes require administrator permission.
Names must match exactly and identify one non-deleted routine; use an ID from routine list
if names collide. --expected-version is required, a positive integer up to 2147483647.
Copy the current version from routine show/list. Conflicts are not retried automatically;
inspect the current routine before deciding whether to apply the change again.
Human output shows metadata, status and the new version; --json emits the API response.
${action === "enable" ? "Use routine runs to inspect later admission and task outcomes; enabling is not task success." : "The API response includes admittedRunsMayFinish; a human warning is written to stderr."}
Example: armada routine ${action} ROUTINE_UUID --expected-version 2 --org ORG_UUID --json
`;
}

function routineDefinitionHelp(action: "create" | "update"): string {
  const creating = action === "create";
  return `Usage: armada routine ${action} ${creating ? "NAME" : "NAME|ID --expected-version N"} [configuration] [--org NAME|UUID] [--json]
${creating ? "Create a paused scheduled template launch; enable it separately to schedule its first occurrence." : "Update an existing routine, guarded by its current version. This is not a manual launch."}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Organization-scoped writes require administrator permission.
${creating ? "--scope personal|org selects visibility; required with explicit --org. Otherwise scope defaults\nto personal in the selected organization. NAME supplies the name, not the JSON file." : "Names must match exactly and identify one non-deleted routine; use an ID from routine list\nif names collide. --expected-version is a required positive integer up to 2147483647.\nCopy it from routine show/list. A conflict is not retried; inspect before deciding to update.\nThe target keeps its owner and scope."}

Choose ONE configuration form (file and inline flags cannot be mixed):
${creating ? "  --file config.json\n  --template UUID --revision N (--prompt TEXT | --prompt-file PATH)\n    --cron EXPRESSION --timezone IANA_ZONE [--ttl 1h] [--max-runs-per-day N]\nJSON requires templateId, templateRevision, prompt, cron and timezone. Optional ttlSeconds\nand maxRunsPerDay default to 3600 and 24. --prompt-file reads UTF-8 without trimming;\nuse --prompt-file - for stdin. Template revision must be a positive integer." : "  --file config.json                     Replace ALL mutable configuration.\n  --cron EXPRESSION --timezone IANA_ZONE  Change only the schedule.\nUpdate JSON requires name, templateId, templateRevision, prompt, cron, timezone,\nttlSeconds and maxRunsPerDay. Missing fields are not retained. Inline updates retain\ncurrent mutable fields and send a complete replacement guarded by --expected-version."}
Neither JSON file accepts org, owner, scope or intervalHours.
Quote the standard five-field cron expression and use an IANA zone such as UTC or Europe/Paris.
Runs must stay at least ONE HOUR apart, including DST transitions. TTL is 5 minutes–24 hours;
maxRunsPerDay is 1–24 admitted launches. Prompts are readable configuration, never secrets.
${creating ? "Routines run as their owner, not whoever later inspects them." : "Updating an enabled routine selects its next matching occurrence; already admitted runs are not stopped."}
Human output shows metadata and version; --json emits the API response with item.
Example: armada routine ${action} ${creating ? "nightly --scope personal" : "ROUTINE_UUID --expected-version 2"} --file config.json --org ORG_UUID --json
`;
}

function vaultSetHelp(resource: "vars" | "secrets"): string {
  return `Usage: armada ${resource} set NAME [--file PATH] [--scope personal|org] [--org NAME|UUID] [--json]
Create a new ${resource === "vars" ? "readable application variable" : "write-only application secret"}, not a model/provider credential.
Set creates an entry, not an update; duplicate names conflict.
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
--scope personal|org selects visibility. Explicit --org requires explicit --scope;
without --org, scope defaults to personal in the selected organization.
Only administrators can create organization-scoped entries.

Values come only from piped stdin or --file PATH, never command arguments.
Provide UTF-8 input; content is preserved without trimming and is not echoed or cached.
Do not embed sensitive values in shell commands or shared logs. Protect local input files.
${resource === "vars" ? "Variables are readable, not secrets: vars read can print their values and launch manifests\nmay contain them. Use secrets set for sensitive application values." : "Secret values are write-only: there is no read, reveal or export operation.\nUse secrets rotate with an ID and expected version to replace an existing active value."}
Human output shows metadata only; --json emits {item: metadata}, never the submitted value.
Use ${resource} list for IDs and versions. This command does not deliver values to a sandbox.
Example: armada ${resource} set ${resource === "vars" ? "APP_REGION" : "APP_PASSWORD"} --file /private/input.txt --scope personal --org ORG_UUID --json
`;
}

function secretLifecycleHelp(action: "rotate" | "revoke" | "delete"): string {
  const effect = {
    rotate:
      "Replace the stored value of an active application secret, not a model/provider credential.\nProvide replacement UTF-8 content only through piped stdin or --file PATH, never argv.\nInput is preserved without trimming, not echoed or cached. Protect local input files.",
    revoke:
      "Revoke an application secret and clear its stored value. Revocation is terminal;\na revoked secret cannot be rotated back to active. Delete it before reusing its name.",
    delete:
      "Mark an application secret deleted and clear its stored value, allowing name reuse.\nThis is not sandbox deletion or upstream credential revocation.",
  }[action];
  return `Usage: armada secrets ${action} ID --expected-version N ${action === "rotate" ? "[--file PATH] " : ""}[--org NAME|UUID] [--json]
${effect}
Requires Armada login or ARMADA_TOKEN; select an organization with --org or armada org use.
Use an ID and current version from secrets list, not a secret name.
--expected-version is required and must be a positive safe integer. A stale version is
refused, not retried automatically; inspect metadata before deciding to try again.
Only administrators can mutate organization-scoped secrets; the ID determines scope.
Human output shows metadata only; --json emits {item: metadata}, never secret values.
Secrets have no read, reveal or export operation. No sandbox delivery or upstream
credential rotation is performed by this command.
Example: armada secrets ${action} SECRET_UUID --expected-version 2 ${action === "rotate" ? "--file /private/replacement.txt " : ""}--org ORG_UUID --json
`;
}

function vaultFamilyHelp(resource: "vars" | "secrets"): string {
  return `Usage: armada ${resource} <command> [arguments]
Manage ${resource === "vars" ? "readable application variables" : "write-only application secrets"}, not model/provider credentials.

${resource === "vars" ? "  set   Create a new variable from stdin or file, not an update.\n  list  Inspect visible metadata and IDs without values.\n  read  Print a value by ID, exactly without adding a newline; --json includes value." : "  set     Create a new secret from stdin or file, not an update.\n  list    Inspect visible metadata, IDs and versions, never values.\n  rotate  Replace an active secret value, guarded by --expected-version.\n  revoke  Terminally revoke and clear the stored value; no reactivation.\n  delete  Mark deleted and clear the value, allowing name reuse."}

Actions require Armada login or ARMADA_TOKEN. Select an organization with --org
NAME|UUID or armada org use. Explicit --org on set requires --scope personal|org;
otherwise set defaults to personal in the selected organization.
Lists include your personal entries and visible organization entries.
Only administrators can mutate organization-scoped entries; IDs determine scope.
Values come from piped stdin or --file, never arguments; protect local input files.
${resource === "vars" ? "Variables are readable, not secrets, and values may appear in launch manifests.\nUse secrets for sensitive application values." : "Secrets have no read, reveal or export operation. Guarded changes use IDs and current\nversions from secrets list. On version conflicts inspect before deciding to retry."}
Lists and writes emit metadata only, including with --json.
These management commands do not deliver values to sandboxes or rotate upstream credentials.
Inspect a command's options with armada ${resource} <command> --help.
Example: armada ${resource} list --org ORG_UUID --json
Example: armada ${resource} set ${resource === "vars" ? "APP_REGION" : "APP_PASSWORD"} --file /private/input.txt --scope personal --org ORG_UUID --json
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
      "remove",
      "visibility",
    ].includes(parts[1] ?? "")
  )
    parts[0] = "snapshot";
  if (parts.length === 1 && parts[0] === "golden") parts[0] = "snapshot";
  const command = parts.join(" ");
  const focused = findCommand(command);
  if (focused) return focused.help;
  const nested = findCommand(command.split(" ", 1)[0] ?? "")?.subcommandHelp;
  if (nested && Object.hasOwn(nested, command)) return nested[command];
  return Object.hasOwn(GENERATED_HELP, command)
    ? GENERATED_HELP[command]
    : Object.hasOwn(HELP, command)
      ? HELP[command]
      : undefined;
}

const GENERATED_HELP: Record<string, string> = {
  "template create": templateDefinitionHelp("create"),
  "template publish": templateDefinitionHelp("publish"),
  "routine enable": routineStateHelp("enable"),
  "routine pause": routineStateHelp("pause"),
  "routine delete": routineStateHelp("delete"),
  "routine create": routineDefinitionHelp("create"),
  "routine update": routineDefinitionHelp("update"),
  "vars set": vaultSetHelp("vars"),
  "secrets set": vaultSetHelp("secrets"),
  "secrets rotate": secretLifecycleHelp("rotate"),
  "secrets revoke": secretLifecycleHelp("revoke"),
  "secrets delete": secretLifecycleHelp("delete"),
  vars: vaultFamilyHelp("vars"),
  secrets: vaultFamilyHelp("secrets"),
  "mcp connect": mcpAuthorizationHelp("connect"),
  "mcp reconnect": mcpAuthorizationHelp("reconnect"),
  "github connect": githubAuthorizationHelp("connect"),
  "github reconnect": githubAuthorizationHelp("reconnect"),
  "github install": githubAuthorizationHelp("install"),
  "creds import": importHelp(),
  "creds import claude": importHelp("claude"),
  "creds import codex": importHelp("codex"),
};

function commandHelp({ help, subcommandHelp }: Command): string[] {
  return [help, ...Object.values(subcommandHelp ?? {})];
}

/** Flags from the command help registry also drive shell discovery. */
export const helpOptionWords = [
  ...new Set(
    [
      ...Object.entries(HELP).flatMap(([key, help]) => [
        ...commands.filter((command) => command.completionBefore === key).flatMap(commandHelp),
        help,
      ]),
      ...Object.values(GENERATED_HELP),
      ...commands
        .filter((command) => command.completionBefore === undefined || !Object.hasOwn(HELP, command.completionBefore))
        .flatMap(commandHelp),
    ].flatMap((help) => [...help.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0])),
  ),
];
