import { commandWords } from "./command-catalog.ts";
import { focusedHelp } from "./commands/index.ts";

export function failureHint(error: unknown, argv: readonly string[], token: boolean): string {
  const failure = error as { code?: string; serverCode?: string; message?: string };
  const message = failure.message ?? "";
  const code = failure.serverCode ?? failure.code;
  if (code === "unauthorized")
    return token ? "Next step: check or replace ARMADA_TOKEN.\n" : "Next step: run armada login.\n";
  if (/\b(run armada|inspect armada|ask an administrator|request.key|request.id|before retrying)\b/i.test(message))
    return "";
  if (["usage", "invalid_config", "invalid", "invalid_request"].includes(code ?? "")) {
    const command: string[] = [];
    for (const part of argv) {
      if (part.startsWith("-") || command.length === 3) break;
      command.push(part);
    }
    if (!commandWords.includes(command[0] ?? "")) command.length = 0;
    while (command.length > 1 && !focusedHelp([...command, "--help"])) command.pop();
    return `Next step: run armada ${command.length ? `${command.join(" ")} ` : ""}--help.\n`;
  }
  if (code === "unsupported" || code === "not_implemented")
    return "Next step: ask an administrator to verify and update the Armada deployment.\n";
  if (/\bEADDRINUSE\b|already in use/i.test(message))
    return "Next step: choose a free local port (armada port-forward [sandbox-id] <remote-port> <local-port>) or stop the process using it.\n";
  if (/^Could not bind /i.test(message))
    return "Next step: choose another local port above 1024 or check local port permissions.\n";
  return "Next step: check the server connection and run armada info --setup.\n";
}
