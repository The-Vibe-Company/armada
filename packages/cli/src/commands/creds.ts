import { credsCommand, vaultIo } from "../vault-commands.ts";
import type { Command } from "./command.ts";

function importHelp(harness?: string) {
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

export default {
  name: "creds",
  summary: "Manage encrypted model and provider credentials",
  usage: {
    "credential-setup": `  armada creds login codex --name <name> [--org <name>]
                                           Native local device login; up to 16 minutes after the device code.
                                           Keep this terminal open; Ctrl-C/shell exit cancels.
  armada creds import claude|codex --name <name> [--file <path>] [--org <name>]
                                           Import a locally obtained native token/auth.json; never pass secrets as arguments
  armada creds limits <account-id> [--model <model-id>] --max-agents N | --unlimited [--org <name>]
                                           Set the maximum simultaneous running agents for a model account
  armada creds presets [--json]             List the same model connection providers as the dashboard
  armada creds connect <preset> --name NAME [--file PATH] [--org NAME]
                                           Provider key from hidden input, stdin/file; custom providers take --models and --base-url
                                           Azure models are resource deployment names; official Azure addresses are tested
                                           with a tiny billable request per deployment. A failed check saves nothing.
  armada creds set <kind> [--org <name>] [--file <path>]
                                           Store an encrypted credential; use hidden terminal input, stdin or a file
                                           Model accounts: --max-agents N or --unlimited (Morph defaults to 2; others unlimited)
                                           Model accounts: --name NAME creates; --id UUID --expected-version N replaces
                                           Codex: --base-url URL --models deployment,model [--api-version VERSION]
                                           Key from hidden input, stdin/file; Azure requires actual deployment names, not model catalog IDs
                                           Codex endpoints require Modal and the Responses API, not chat completions
                                           Claude: --base-url URL [--endpoint-auth bearer|api-key] (default bearer)
                                           Claude gateways require Modal and support Claude models only; key from hidden input, stdin/file
                                           Endpoint prices: --price-model ID --price-input USD --price-output USD
                                           [--price-cached-input USD]; decimal USD per million tokens, omitted = unknown
                                           Replacing a connection replaces its prices too; re-enter all rates to keep them`,
    "credential-accounts": `  armada creds test <sandbox-id> --model <deployment-model> [--org <name>] [--json]
                                           One tiny billable check of the bound custom connection in a running Modal sandbox
  armada creds list [--org <name>]         Account IDs, names, defaults and safe metadata; never values
  armada creds rename <id> <name> [--org <name>]
  armada creds default|remove <id> [--org <name>]
  armada creds rm <kind> [--org <name>]
                                           kinds: claude-oauth, anthropic, openai, codex-auth, boat, modal, skillpack`,
  },
  help: `Usage: armada creds <command> [arguments]
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
  subcommandHelp: {
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
    "creds import": importHelp(),
    "creds import claude": importHelp("claude"),
    "creds import codex": importHelp("codex"),
  },
  helpWhenBare: true,
  useSelectedOrg: (argv) => argv[0] === "list",
  async run(argv, { auth, deps }) {
    return credsCommand(argv, vaultIo(auth, deps));
  },
} satisfies Command;
