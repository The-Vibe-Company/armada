import { commandWords } from "./command-catalog.ts";
import { focusedHelp } from "./commands/index.ts";

/** Keep recovery instructions already supplied by the owning operation authoritative. */
export function failureHint(error: unknown, argv: readonly string[], token: boolean): string {
  const failure = error as { code?: string; serverCode?: string; message?: string };
  const message = failure.message ?? "";
  const code = failure.serverCode ?? failure.code;
  if (code === "unauthorized")
    return token ? "Next step: check or replace ARMADA_TOKEN.\n" : "Next step: run armada login.\n";
  if (/\b(run armada|inspect armada|ask an administrator|request.key|request.id|before retrying)\b/i.test(message))
    return "";
  if (["usage", "invalid_config", "invalid", "invalid_request"].includes(code ?? "")) {
    const command = argv.slice(0, 2).filter((part) => !part.startsWith("-"));
    if (!commandWords.includes(command[0] ?? "")) command.length = 0;
    while (command.length > 1 && !focusedHelp([...command, "--help"])) command.pop();
    return `Next step: run armada ${command.length ? `${command.join(" ")} ` : ""}--help.\n`;
  }
  if (code === "unsupported" || code === "not_implemented")
    return "Next step: ask an administrator to verify and update the Armada deployment.\n";
  return "Next step: check the server connection and run armada doctor.\n";
}
