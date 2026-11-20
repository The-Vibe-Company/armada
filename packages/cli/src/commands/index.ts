import { bindCredential, mcp } from "../operation-commands.ts";
import account from "./account.ts";
import advice from "./advice.ts";
import api from "./api.ts";
import { secrets, vars } from "./application-vault.ts";
import type { Command, UsageGroup } from "./command.ts";
import completion from "./completion.ts";
import creds from "./creds.ts";
import detail from "./detail.ts";
import extend from "./extend.ts";
import host from "./host.ts";
import interrupt from "./interrupt.ts";
import login from "./login.ts";
import logout from "./logout.ts";
import ls from "./ls.ts";
import newSandbox from "./new.ts";
import org from "./org.ts";
import prompt from "./prompt.ts";
import recovery from "./recovery.ts";
import report from "./report.ts";
import rm from "./rm.ts";
import routine from "./routine.ts";
import { sandboxInspectionCommands } from "./sandbox-inspection.ts";
import snapshot from "./snapshot.ts";
import status from "./status.ts";
import stop from "./stop.ts";
import template from "./template.ts";
import { tokenCommands } from "./token.ts";
import wait from "./wait.ts";

export const commands: readonly Command[] = [
  newSandbox,
  ls,
  advice,
  rm,
  extend,
  status,
  detail,
  recovery,
  stop,
  interrupt,
  wait,
  report,
  prompt,
  ...sandboxInspectionCommands,
  completion,
  login,
  logout,
  ...tokenCommands,
  account,
  api,
  org,
  host,
  routine,
  template,
  vars,
  secrets,
  mcp,
  bindCredential,
  snapshot,
  creds,
];

const byName = new Map(commands.map((command) => [command.name, command]));

export function findCommand(name: string) {
  return byName.get(name);
}

export function sandboxUsage(group: UsageGroup): string {
  return commands
    .map(({ usage }) => (typeof usage === "string" ? (group === "sandbox" ? usage : undefined) : usage[group]))
    .filter(Boolean)
    .join("\n");
}

export function focusedHelp(argv: readonly string[]) {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const parts = argv.slice(0, -1);
  const path = parts.join(" ");
  const command = byName.get(path);
  if (command) return command.help;
  const nested = byName.get(path.split(" ", 1)[0] ?? "")?.subcommandHelp;
  return nested && Object.hasOwn(nested, path) ? nested[path] : undefined;
}
