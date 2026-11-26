import { accountCommand } from "../account-commands.ts";
import { parseAccountArgs, vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

function importHelp(harness?: string) {
  return `Usage: armada account import ${harness ?? "claude|codex|antigravity"} (--name <name> | --id <id> --expected-version <version>) [--file <path>] [--org <name>]
Import an existing native credential after Armada login; no native login is started.
Claude: run claude setup-token locally. Codex: supply native auth JSON.
Antigravity: pass --file with a Google token file from the native CLI.
Read the credential from stdin/hidden input or a private --file, never command arguments.
Use --name to create; replacement requires --id and a positive integer --expected-version.
Set the account cap with --max-agents N or --unlimited.
Omit --org for personal scope; pass it for organization scope.
Credentials are stored encrypted; allowance information may be unavailable.
Example: armada account import ${harness ?? "claude"} --name personal --file /private/native-credential
`;
}

const nativeLoginHelp = `Usage: armada account login codex (--name <name> | --id <id> --expected-version <version>) [--org <name>]
Requires a ChatGPT subscription with Codex access and an Armada login.
Approve the native device login in your browser; keep this terminal open until publishing finishes.
Use --name to create an account; replacement requires --id and a positive integer --expected-version.
Set the account cap with --max-agents N or --unlimited.
Omit --org for personal scope; pass it for organization scope.
Example: armada account login codex --name personal
`;

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
  summary: "Manage model credentials, GitHub access and your Armada session",
  usage: {
    hosts: `  armada account ls|add|login|import|default|limits|rm|test
                                           Manage encrypted model accounts (see account --help)
  armada account ls|add|login|rm github    Manage GitHub connection and installations
  armada account status|logout             Show server account status or revoke login session`,
  },
  help: `Usage: armada account <command> [arguments]
Manage model credentials, GitHub access or your personal Armada session.
  ls            List credential metadata.
  add           Store a credential kind.
  login codex|antigravity   Connect a model account in your browser.
  import        Import native Claude, Codex or Antigravity credentials securely.
  default       Select a default model account by ID.
  limits        Set an account or model concurrency cap.
  rm            Remove a named account by ID or a credential with --kind.
  test          Check a sandbox's bound API-key connection.
Supply API keys and imported credentials through hidden input, stdin or a private file.
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
    "account login": `Usage: armada account login codex|antigravity (--name <name> | --id <id> --expected-version <version>) [--org <name>]
Codex uses a native device login. Antigravity uses a Google sign-in code. Use leaf --help for details.
`,
    "account login antigravity": `Usage: armada account login antigravity (--name <name> | --id <id> --expected-version <version>) [--org <name>]
Open the Google link and paste the code when prompted. Omit --org for a personal account.
`,
    "account login codex": nativeLoginHelp,
    "account ls": `Usage: armada account ls [--org <name>] [--json]
List credential metadata after Armada login; secret values are never returned.
Use --json to obtain account IDs for default and rm.
Example: armada account ls --json
`,
    "account default": `Usage: armada account default <id> [--org <name>] [--json]
Select a default credential account after Armada login and server authorization.
Use an account ID from armada account ls --json. Output is JSON even without --json.
Omit --org for your personal account; pass it for an organization account.
Example: armada account default ACCOUNT_UUID
`,
    "account rm": `Usage: armada account rm (<id> | --kind <kind>) [--org <name>] [--json]
Remove a credential account by ID after Armada login and server authorization.
Use an account ID from armada account ls --json. Output is JSON even without --json.
Omit --org for your personal account; pass it for an organization account.
To remove a kind-scoped credential, use account rm --kind <kind>.
Example: armada account rm ACCOUNT_UUID
`,
    "account limits": `Usage: armada account limits <account-id> [--model <model-id>] (--max-agents N | --unlimited) [--org <name>] [--json]
Set the maximum agents running at the same time across sandbox providers.
With --model, set that exact launch model ID instead; --unlimited clears its override.
Accounts without a model override use only their account-wide cap.
account ls --json exposes modelLimits and modelCounts.
Stopped and idle-paused sandboxes do not count. New starts beyond the cap are refused before allocation.
Existing running agents are not stopped when lowering the cap.
`,
    "account test": `Usage: armada account test <sandbox-id> --model <deployment-model> [--org <name>] [--json]
Test a bound API-key connection on a running Modal or runtime-backed Boat sandbox.
Supports Claude Code, Codex and custom OpenCode connections. Requires sandbox ownership.
This can make a billable provider request. No keys or URLs are accepted as arguments.
A successful check is not a full harness compatibility test. Failure exits 1.
Example: armada account test SANDBOX_UUID --model deployment-name --json
`,
    "account add": `Usage: armada account add <kind> [--name NAME | --id UUID --expected-version N] [--org NAME] [--file PATH]
Read credentials from stdin, hidden input or a private file. Omit --org for personal scope.
For a Gemini API key, use armada account add antigravity --name NAME [--file PATH].
OpenAI custom endpoints also accept --api-version where supported.
Official Azure addresses make a tiny billable request per deployment before storing the account.
Custom OpenAI and OpenCode endpoints require --base-url and exact --models IDs.
Claude gateways take --base-url and optional --endpoint-auth bearer|api-key (default bearer).
Custom endpoints accept --price-model, --price-input, --price-output and optional --price-cached-input
in USD per million tokens. Re-enter prices when replacing a connection.
Set a named account cap with --max-agents N or --unlimited. Morph defaults to 2.
`,
    "account import": importHelp(),
    "account import claude": importHelp("claude"),
    "account import codex": importHelp("codex"),
    "account import antigravity": importHelp("antigravity"),
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
  automaticJson: true,
  helpWhenBare: true,
  useSelectedOrg(argv) {
    const args = parseAccountArgs(argv);
    return args.positionals[0] === "ls" && args.positionals.length === 1;
  },
  async run(argv, { auth, deps }) {
    return accountCommand(argv, vaultIo(auth, deps));
  },
} satisfies Command;
