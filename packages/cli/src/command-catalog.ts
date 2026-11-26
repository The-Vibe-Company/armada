import { AuthError } from "@armada/auth";
import { VERSION } from "@armada/core";
import type { AuthIo } from "./auth-commands.ts";
import { commands, sandboxUsage } from "./commands/index.ts";

export const HELP = `armada ${VERSION}: launch coding agents in provider-scoped sandboxes

Bare command families print help on stdout and exit 0; unknown subcommands exit 2.

Global: --profile NAME (or ARMADA_PROFILE) isolates saved login and preferences; login --url sets its server.
--profile overrides ARMADA_PROFILE. Omit both for the existing default profile.
Names: 1–64 letters/digits/underscores/hyphens, starting with a letter or digit.
ARMADA_TOKEN is not isolated by profiles: it still overrides every saved login.
Use a matching ARMADA_URL for token-authenticated scripts; never put tokens in arguments.
Example: armada --profile staging login --url https://staging.example.com

Exit codes: 0 success; 1 server/operation failure; 2 invalid usage or missing configuration; 3 authentication failure.
Scripts: check exit status before consuming stdout; failed operations may have partial output.
Sandbox commands use JSON when stdout is redirected or when you pass --json.
In machine mode, the final stderr line on failure is {error:{code,message,hint}}.
Progress and warnings can appear earlier on stderr.
See command --help for supported JSON output; keep captured values/tokens out of shared logs.

Quick start / common examples:
  armada login
  armada org list
  armada login --org my-team
  armada info --setup
  armada host add --name my-workstation
  armada new
  armada ls
  armada info SANDBOX_ID
  armada prompt SANDBOX_ID "Continue the task"
  armada events SANDBOX_ID --tail 20
  armada stop SANDBOX_ID
  eval "$(armada completion bash)"

Usage: armada [global options] <command> [arguments]

Sandboxes:
${sandboxUsage("sandboxes")}

Interactive & Relay:
${sandboxUsage("interactive")}

Templates & Snapshots:
${sandboxUsage("templates")}

Hosts & Accounts:
${sandboxUsage("hosts")}

Auth & API:
${sandboxUsage("auth")}
  armada skill install (--project <dir> | --global) --yes [--revision <sha>]
                                           Install Armada tool-knowledge skill from GitHub (no login)
  armada --version                         Print the CLI version
  armada --help                            Show this help (also -h, help [command]); no login required

Every command after 'armada login' acts as the user who signed in. snapshot commands take --org <name>
when you belong to more than one org.

Give an agent access:
  Create an API key in Dashboard Settings or run:
  armada api token/create '{"label":"worker","org":"ORG_UUID"}'
  Store the response's token securely. Set ARMADA_URL and inject the key as ARMADA_TOKEN.
  Verify with armada whoami.

Environment:
  ARMADA_TOKEN                             API token for non-interactive authentication. Takes precedence over
                                           a saved login session.
  ARMADA_URL                               Armada API server (default: https://armada.thevibecompany.co).
  ARMADA_SANDBOX                           Current sandbox UUID or unique prefix. A sandbox argument overrides it;
                                           otherwise the CLI falls back to .armada/sandbox in the current directory.
`;

export const commandWords = [
  ...new Set([
    ...[...HELP.matchAll(/armada ([a-z][a-z|-]*)/g)].flatMap((match) => match[1]!.split("|")),
    ...commands.map(({ name }) => name),
  ]),
];
function optionFlags(help: string) {
  return [...help.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]);
}

const optionWords = [
  ...new Set([
    ...commands
      .flatMap(({ help, subcommandHelp }) => [help, ...Object.values(subcommandHelp ?? {})])
      .flatMap(optionFlags),
    ...optionFlags(HELP),
  ]),
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
