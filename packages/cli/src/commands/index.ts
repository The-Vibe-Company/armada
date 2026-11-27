import account from "./account.ts";
import api from "./api.ts";
import bindCredential from "./bind-credential.ts";
import type { Command, UsageGroup } from "./command.ts";
import completion from "./completion.ts";
import host from "./host.ts";
import info from "./info.ts";
import login from "./login.ts";
import logout from "./logout.ts";
import ls from "./ls.ts";
import newSandbox from "./new.ts";
import org from "./org.ts";
import prompt from "./prompt.ts";
import report from "./report.ts";
import rm from "./rm.ts";
import { sandboxInspectionCommands } from "./sandbox-inspection.ts";
import snapshot from "./snapshot.ts";
import stop from "./stop.ts";
import template from "./template.ts";
import whoami from "./whoami.ts";

export const commands: readonly Command[] = [
  newSandbox,
  ls,
  info,
  rm,
  stop,
  report,
  prompt,
  ...sandboxInspectionCommands,
  completion,
  login,
  logout,
  whoami,
  account,
  api,
  org,
  host,
  template,
  bindCredential,
  snapshot,
];

const byName = new Map(commands.map((command) => [command.name, command]));

export function findCommand(name: string) {
  return byName.get(name);
}

export function sandboxUsage(group: UsageGroup): string {
  return commands
    .map(({ usage }) => (typeof usage === "string" ? (group === "sandboxes" ? usage : undefined) : usage[group]))
    .filter(Boolean)
    .join("\n");
}

const KNOWN_BOOLEAN_FLAGS = new Set(
  "--private --json --no-browser --no-wait --no-connections --page-info --active --wide --yes --live --setup --wait --turn --after --steer --replace --auto --unlimited --armada-access --keep-after-merge -f --follow --global".split(
    " ",
  ),
);

export function helpForPath(parts: readonly string[]) {
  if (!parts.length) return undefined;
  const path = parts.join(" ");
  const command = byName.get(path);
  if (command) return command.help;
  const nested = byName.get(parts[0] ?? "")?.subcommandHelp;
  return nested && Object.hasOwn(nested, path) ? nested[path] : undefined;
}

export function focusedHelp(argv: readonly string[]) {
  if (!["--help", "-h"].includes(argv.at(-1) ?? "")) return undefined;
  const before = argv.slice(0, -1);
  if (before.includes("--")) return undefined;
  const direct = helpForPath(before);
  if (direct) return direct;
  const path: string[] = [];
  let index = 0;
  while (index < before.length && !before[index]!.startsWith("-")) {
    path.push(before[index]!);
    index++;
  }
  const matched = helpForPath(path);
  if (!matched || index === before.length) return undefined;
  for (; index < before.length; index++) {
    const token = before[index]!;
    if (!token.startsWith("-") || token === "--help" || token === "-h") return undefined;
    if (token.includes("=") || KNOWN_BOOLEAN_FLAGS.has(token)) continue;
    const next = before[index + 1];
    if (next === undefined || next.startsWith("-")) return undefined;
    index++;
  }
  return matched;
}
