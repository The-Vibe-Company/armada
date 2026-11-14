// Exact command boundaries only: never interpret payload or remote arguments as help.
const HELP: Record<string, string> = {
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

export function onboardingHelp(argv: readonly string[]): string | undefined {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const parts = argv.slice(0, -1);
  // Keep the legacy spelling usable without changing literal arguments.
  if (
    parts[0] === "golden" &&
    [
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
  const command = parts.join(" ");
  if (command === "creds import") return importHelp();
  if (command === "creds import claude") return importHelp("claude");
  if (command === "creds import codex") return importHelp("codex");
  return Object.hasOwn(HELP, command) ? HELP[command] : undefined;
}
