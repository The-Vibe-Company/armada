import advice from "./advice.ts";
import type { Command, UsageGroup } from "./command.ts";
import detail from "./detail.ts";
import exec from "./exec.ts";
import extend from "./extend.ts";
import interrupt from "./interrupt.ts";
import launch from "./launch.ts";
import list from "./list.ts";
import recovery from "./recovery.ts";
import report from "./report.ts";
import rm from "./rm.ts";
import send from "./send.ts";
import status from "./status.ts";
import steer from "./steer.ts";
import stop from "./stop.ts";
import wait from "./wait.ts";

export const commands: readonly Command[] = [
  launch,
  list,
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
  send,
  steer,
  exec,
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
