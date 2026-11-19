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
${sandboxUsage("snapshots")}
${sandboxUsage("launch")}
${sandboxUsage("list")}
${sandboxUsage("mcp-bindings")}
${sandboxUsage("advice")}
${sandboxUsage("bind-credential")}
${sandboxUsage("sandbox")}
${sandboxUsage("snapshot-admin")}
${sandboxUsage("mcp")}
${sandboxUsage("logs")}
${sandboxUsage("session")}
${sandboxUsage("org")}
${sandboxUsage("account")}
${sandboxUsage("github")}
${sandboxUsage("invitations")}
${sandboxUsage("credential-setup")}
${sandboxUsage("automation")}
${sandboxUsage("vault")}
                                           Personal or --org scope. JSON includes values only for vars read; no sandbox delivery.
${sandboxUsage("credential-accounts")}

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
function optionFlags(help: string) {
  return [...help.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]);
}

export const optionWords = [
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
