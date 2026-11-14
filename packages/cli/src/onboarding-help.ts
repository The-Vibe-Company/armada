// Exact command boundaries only: never interpret payload or remote arguments as help.
const HELP: Record<string, string> = {
  "org setup": `Usage: armada org setup [--org <name>]
Show organization provider setup status. Sign in before running the operation.
Example: armada org setup --org my-team
`,
  "org connect modal": `Usage: armada org connect modal [--org <name>] [--file <path>]
Connect a Modal workspace as an organization admin after armada login.
Input: JSON with token_id and token_secret (from Modal), or a Modal token pair separated by whitespace.
Keep real credentials in a private file or stdin, never command arguments.
Example: armada org connect modal --org my-team --file /private/modal.json
`,
  "creds login codex": `Usage: armada creds login codex --name <name> [--org <name>]
Requires a ChatGPT subscription with Codex access and an Armada login.
Approve the native device login in your browser; keep this terminal open.
Example: armada creds login codex --name personal
`,
  "creds set": `Usage: armada creds set <kind> [--name <name>] [--org <name>] [--file <path>]
Store an encrypted credential after armada login. Read the secret from hidden input,
stdin or a private file, never command arguments. API keys use provider billing;
subscription credentials require an eligible subscription, not an API key.
Example: armada creds set openai --name personal --file /private/openai-key
`,
  "golden create": `Usage: armada golden create <name> (--repo <url>[@branch] ... | --config <file>)
  [--init <command> ...] [--setup <local-file>] [--provider boat|modal]
  [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
Requires Armada login, a connected provider and GitHub repository authorization.
Builds, scans and snapshots on the server; do not include secrets in setup.
Example: armada golden create starter --provider modal --repo https://github.com/octocat/Hello-World --org my-team
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

export function onboardingHelp(argv: readonly string[]): string | undefined {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const parts = argv.slice(0, -1);
  // Keep the legacy spelling usable without changing literal arguments.
  if (
    parts[0] === "golden" &&
    [
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
  return Object.hasOwn(HELP, command) ? HELP[command] : undefined;
}
