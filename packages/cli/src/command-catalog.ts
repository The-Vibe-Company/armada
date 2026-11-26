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
  armada org use my-team
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

type CompletionNode = { subs: Map<string, CompletionNode>; options: Set<string> };

function ensureNode(root: CompletionNode, path: readonly string[]) {
  let node = root;
  for (const part of path) {
    let next = node.subs.get(part);
    if (!next) {
      next = { subs: new Map(), options: new Set() };
      node.subs.set(part, next);
    }
    node = next;
  }
  return node;
}

function buildCompletionTree() {
  const root: CompletionNode = { subs: new Map(), options: new Set(["--profile", "--help", "--version"]) };
  const add = (path: readonly string[], flags: readonly string[]) => {
    const node = ensureNode(root, path);
    for (const flag of flags) node.options.add(flag);
    node.options.add("--help");
  };
  for (const cmd of commands) {
    add([cmd.name], optionFlags(cmd.help));
    for (const [path, text] of Object.entries(cmd.subcommandHelp ?? {})) add(path.split(" "), optionFlags(text));
  }
  add(["host", "install"], ["--server"]);
  add(["skill"], []);
  add(["skill", "install"], ["--project", "--global", "--yes", "--revision"]);
  for (const word of root.subs.keys()) if (word !== "help") ensureNode(root, ["help", word]);
  return root;
}

function allSubOptions(node: CompletionNode) {
  const options = new Set(node.options);
  for (const leaf of node.subs.values()) for (const flag of leaf.options) options.add(flag);
  return options;
}

function scopedCases(root: CompletionNode) {
  const cases: { pattern: string; words: string }[] = [];
  for (const [name, node] of root.subs) {
    for (const [sub, subNode] of node.subs)
      cases.push({ pattern: `"${name}:${sub}"`, words: [...subNode.subs.keys(), ...allSubOptions(subNode)].join(" ") });
    cases.push({ pattern: `"${name}:"*`, words: [...node.subs.keys(), ...node.options].join(" ") });
  }
  return cases;
}

export function completion(argv: readonly string[], auth: Pick<AuthIo, "out">) {
  if (argv.length !== 1 || !["bash", "zsh", "fish"].includes(argv[0] ?? ""))
    throw new AuthError("Run armada completion bash|zsh|fish, then source the generated script.", "usage");
  const root = buildCompletionTree();
  const top = [...root.subs.keys(), ...root.options].join(" ");
  if (argv[0] === "bash" || argv[0] === "zsh") {
    const zsh = argv[0] === "zsh";
    const body = scopedCases(root)
      .map(({ pattern, words }) =>
        zsh ? `      ${pattern}) c=(${words}) ;;` : `      ${pattern}) words="${words}" ;;`,
      )
      .join("\n");
    auth.out(
      zsh
        ? `#compdef armada\n_armada() {\n  local cmd="" sub="" i=2; local -a c\n  while (( i < CURRENT )); do\n    local w="\${words[i]}"\n    case "$w" in --profile) (( i += 2 )); continue ;; -*) (( i += 1 )); continue ;; esac\n    if [[ -z "$cmd" ]]; then cmd="$w"; elif [[ -z "$sub" ]]; then sub="$w"; else break; fi\n    (( i += 1 ))\n  done\n  if [[ -z "$cmd" ]]; then c=(${top}); else\n    case "$cmd:$sub" in\n${body}\n    esac\n  fi\n  compadd -- "\${c[@]}"\n}\ncompdef _armada armada\n`
        : `_armada_complete() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="" sub="" words="" i=1\n  while [ "$i" -lt "$COMP_CWORD" ]; do\n    local w="\${COMP_WORDS[i]}"\n    case "$w" in --profile) i=$((i + 2)); continue ;; -*) i=$((i + 1)); continue ;; esac\n    if [ -z "$cmd" ]; then cmd="$w"; elif [ -z "$sub" ]; then sub="$w"; else break; fi\n    i=$((i + 1))\n  done\n  if [ -z "$cmd" ]; then words="${top}"; else\n    case "$cmd:$sub" in\n${body}\n    esac\n  fi\n  COMPREPLY=( $(compgen -W "$words" -- "$cur") )\n}\ncomplete -F _armada_complete armada\n`,
    );
    return 0;
  }
  const lines = [
    `complete -c armada -f -n '__fish_use_subcommand' -a '${[...root.subs.keys()].join(" ")}'`,
    ...[...root.options].map((flag) => `complete -c armada -n '__fish_use_subcommand' -l '${flag.slice(2)}'`),
  ];
  for (const [name, node] of root.subs) {
    const subNames = [...node.subs.keys()].join(" ");
    const baseCond = subNames
      ? `__fish_seen_subcommand_from ${name}; and not __fish_seen_subcommand_from ${subNames}`
      : `__fish_seen_subcommand_from ${name}`;
    if (subNames) lines.push(`complete -c armada -f -n '${baseCond}' -a '${subNames}'`);
    for (const flag of node.options) lines.push(`complete -c armada -n '${baseCond}' -l '${flag.slice(2)}'`);
    for (const [sub, subNode] of node.subs) {
      const cond = `__fish_seen_subcommand_from ${name}; and __fish_seen_subcommand_from ${sub}`;
      if (subNode.subs.size)
        lines.push(`complete -c armada -f -n '${cond}' -a '${[...subNode.subs.keys()].join(" ")}'`);
      for (const flag of allSubOptions(subNode)) lines.push(`complete -c armada -n '${cond}' -l '${flag.slice(2)}'`);
    }
  }
  auth.out(`${lines.join("\n")}\n`);
  return 0;
}
