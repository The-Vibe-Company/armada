import type { Command } from "./command.ts";

function completionHelp(shell?: "bash" | "zsh" | "fish") {
  return `Usage: armada completion ${shell ?? "bash|zsh|fish"}
Print a shell-completion script to stdout. No login or network request is needed.
Choose the shell you actually use; inspect the generated script before sourcing it.
This command does not install completion or modify your shell configuration.
Example: armada completion ${shell ?? "bash"} > armada-completion.${shell ?? "bash"}
`;
}

export default {
  name: "completion",
  summary: "Print shell completions",
  usage: { setup: `  armada completion bash|zsh|fish           Print a shell completion script` },
  help: completionHelp(),
  subcommandHelp: {
    "completion bash": completionHelp("bash"),
    "completion zsh": completionHelp("zsh"),
    "completion fish": completionHelp("fish"),
  },
  useSelectedOrg: false,
  async run(argv, { io }) {
    const { completion } = await import("../command-catalog.ts");
    return completion(argv, io);
  },
} satisfies Command;
