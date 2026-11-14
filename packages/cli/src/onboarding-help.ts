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
  "host add": `Usage: armada host add [--name <name>] [--org <UUID>]
Register your Docker machine after Armada login. Select an organization first or pass --org.
Run the returned installer only on your intended host; its registration token is short-lived.
Example: armada host add --name workstation
`,
};

export function onboardingHelp(argv: readonly string[]): string | undefined {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const command = argv.slice(0, -1).join(" ");
  return Object.hasOwn(HELP, command) ? HELP[command] : undefined;
}
