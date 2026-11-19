import type { Command } from "./commands/command.ts";
import { commands, findCommand } from "./commands/index.ts";

// Exact command boundaries only: never interpret payload or remote arguments as help.
const HELP: Record<string, string> = {
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
