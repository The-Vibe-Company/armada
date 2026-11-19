import { AuthError } from "@armada/auth";
import { VERSION } from "@armada/core";
import type { AuthIo } from "./auth-commands.ts";
import { commands, sandboxUsage } from "./commands/index.ts";
import { helpOptionWords } from "./onboarding-help.ts";

export const HELP = `armada ${VERSION}: launch coding agents in provider-scoped sandboxes

Bare command families print help on stdout and exit 0; unknown subcommands exit 2.

Global: --profile NAME (or ARMADA_PROFILE) isolates saved login and preferences; login --url sets its server.
--profile overrides ARMADA_PROFILE. Omit both for the existing default profile.
Names: 1–64 letters/digits/underscores/hyphens, starting with a letter or digit.
ARMADA_TOKEN is not isolated by profiles: it still overrides every saved login.
Use a matching ARMADA_URL for token-authenticated scripts; never put tokens in arguments.
Example: armada --profile staging login --url https://staging.example.com --provider github

Exit codes: 0 success; 1 server/operation failure; 2 invalid usage or missing configuration; 3 authentication failure.
Scripts: check exit status before consuming stdout; failed operations may have partial output.
Common typed errors with --json use {error:{code,message}} on stderr, not stdout.
Progress/warnings can also use stderr; do not assume the entire stream is one JSON document.
See command --help for supported JSON output; keep captured values/tokens out of shared logs.

Quick start / common examples:
  armada login --email you@example.com
  armada org list
  armada org use my-team
  armada doctor
  armada host add --name my-workstation
  armada launch
  armada list
  armada status SANDBOX_ID
  armada send SANDBOX_ID "Continue the task"
  armada logs SANDBOX_ID --tail 20
  armada stop SANDBOX_ID
  eval "$(armada completion bash)"

Usage:
${sandboxUsage("host")}
${sandboxUsage("docker-launch")}
${sandboxUsage("setup")}
  armada --version                         Print the version
  armada --help                            Show this help (also -h or help); no login required
  armada skill install (--project <directory> | --global) --yes [--revision <commit>]
                                           Public GitHub Armada tool-knowledge skill; no login. See skill --help.
  armada snapshot create <name> (--repo <url>[@branch] ... | --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Server-orchestrated: builds, scans and saves the snapshot on the
                                           server over your own GitHub connection. No BOAT_API_KEY needed.
                                           --setup reads a local script and sends its content to run after
                                           cloning, before the scan.
  armada snapshot update <name> (--add-repo <url>[@branch] ... | --replace --repo <url>[@branch] ... | --replace --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Rebuild the existing snapshot in place. One snapshot may contain
                                           many repositories; visibility and ownership stay unchanged.
                                           Use --add-repo to append safely, preserving stored repositories and init commands.
                                           --repo/--config require --replace: they replace the ENTIRE config, even if no repos are dropped.
                                           Create/update admit a durable job, then poll for up to --timeout
                                           seconds (default 60, max 600; 0 returns after admission).
                                           Disconnecting never resubmits or cancels the job.
  armada snapshot build-cancel <job-id> [--org <org>] [--json]  Cancel your queued, never-started build
  armada snapshot build-find <name> [--provider boat|modal] [--org <org>] [--json]
                                           Find the latest visible active build without a job ID or admission key.
  armada snapshot build-status <job-id>      Read the authenticated durable build status
  armada snapshot build-status --idempotency-key <key> --org <org>
                                           Recover an uncertain admission using the saved key.
  armada snapshot capabilities [--provider boat|modal] [--org UUID] [--json]
                                           Server-authoritative snapshot capacity; null means unbounded/unknown
  armada snapshot size-policy <name> [--provider boat|modal] [--org <org>] [--file <JSON|->] [--json]
                                           Inspect defaults, or replace the entire policy from a file/stdin.
                                           Version 1: {"version":1,"golden":null,"repositories":{}}
                                           Repository keys are configured directories. A null default and an empty map
                                           clear defaults. Scoped to this provider snapshot, future launches only.
  armada snapshot create <name> --provider docker --host UUID|NAME --org UUID
                               (--config <file> | --repo <url>[@branch] ... [--init <cmd> ...]) [--private] [--request-id UUID] [--json]
                                           Build a host-local snapshot from the official Armada image and your repos/setup.
                                           No image input. Reuse --request-id with identical input after an unknown outcome.
  armada snapshot list [--provider boat|modal|docker] [--org UUID] [--json]
                                           Snapshots you can see; Docker requires --org.
  armada snapshot get UUID --provider docker --org UUID [--json]
                                           Read snapshot build state; launch ready snapshots with launch --provider docker --agent codex --golden UUID.
  armada snapshot rebuild UUID --provider docker --org UUID [--request-id UUID] [--json]
                                           Build a new snapshot from saved repos/setup on its original host; keep the old one.
${sandboxUsage("launch")}
${sandboxUsage("list")}
${sandboxUsage("mcp-bindings")}
${sandboxUsage("advice")}
${sandboxUsage("bind-credential")}
${sandboxUsage("sandbox")}
  armada snapshot retirement dry-run|reconcile <snapshot-id> [--limit 1-50] [--org UUID]
  armada snapshot remove <name|snapshot-id> [--provider boat|modal] [--org UUID] [--json]
                                           Names must match one visible snapshot; use provider/org or snapshot list --json to disambiguate.
                                           Remove from launch selection; retain children and provider artifacts
  armada snapshot visibility <snapshot-id> --visibility private|org [--org UUID]
${sandboxUsage("mcp")}
${sandboxUsage("logs")}
${sandboxUsage("session")}
${sandboxUsage("org")}
${sandboxUsage("account")}
${sandboxUsage("github")}
${sandboxUsage("invitations")}
  armada creds login codex --name <name> [--org <name>]
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
                                           Replacing a connection replaces its prices too; re-enter all rates to keep them
${sandboxUsage("automation")}
${sandboxUsage("vault")}
                                           Personal or --org scope. JSON includes values only for vars read; no sandbox delivery.
  armada creds test <sandbox-id> --model <deployment-model> [--org <name>] [--json]
                                           One tiny billable check of the bound custom connection in a running Modal sandbox
  armada creds list [--org <name>]         Account IDs, names, defaults and safe metadata; never values
  armada creds rename <id> <name> [--org <name>]
  armada creds default|remove <id> [--org <name>]
  armada creds rm <kind> [--org <name>]
                                           kinds: claude-oauth, anthropic, openai, codex-auth, boat, modal, skillpack

Every command after 'armada login' acts as the user who signed in. snapshot commands take --org <name>
when you belong to more than one org.

Environment:
  ARMADA_TOKEN                             API token for non-interactive authentication. Takes precedence over
                                           a saved login session.
  ARMADA_URL                               Armada API server (default: https://armada.thevibecompany.co).
`;

export const commandWords = [
  ...new Set([
    ...[...HELP.matchAll(/armada ([a-z][a-z|-]*)/g)].flatMap((match) => match[1]!.split("|")),
    ...commands.map(({ name }) => name),
  ]),
];
export const optionWords = [
  ...new Set([...helpOptionWords, ...[...HELP.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0])]),
];

export function completion(argv: readonly string[], auth: Pick<AuthIo, "out">) {
  if (argv.length !== 1 || !["bash", "zsh", "fish"].includes(argv[0] ?? ""))
    throw new AuthError("Run armada completion bash|zsh|fish, then source the generated script.", "usage");
  const words = [...commandWords, ...optionWords].join(" ");
  auth.out(
    argv[0] === "bash"
      ? `complete -W '${words}' armada\n`
      : argv[0] === "zsh"
        ? `#compdef armada\n_armada() { compadd -- ${words}; }\ncompdef _armada armada\n`
        : `complete -c armada -f -a '${commandWords.join(" ")}'\n${optionWords.map((word) => `complete -c armada -l '${word.slice(2)}'`).join("\n")}\n`,
  );
  return 0;
}
