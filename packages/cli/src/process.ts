// OS inspection for a watch lock. No shell, and command lines never leave this adapter except as identity.
import { readFile, readlink } from "node:fs/promises";
import type { Exec, ProcessIdentity } from "./io.ts";

interface ProcessSystem {
  platform: string;
  cwd: string;
  readFile: (path: string) => Promise<string>;
  readlink: (path: string) => Promise<string>;
}

/** Linux uses kernel start ticks; macOS uses ps's start time and lsof's cwd. Failure means unverified. */
export async function inspectProcess(
  exec: Exec,
  pid: number,
  system: ProcessSystem = {
    platform: process.platform,
    cwd: process.cwd(),
    readFile: (path) => readFile(path, "utf8"),
    readlink,
  },
): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const options = { cwd: system.cwd };
    const commandArgs = ["-ww", "-p", String(pid), "-o", "command="];
    if (system.platform === "linux") {
      const before = await system.readFile(`/proc/${pid}/stat`);
      const [command, cwd, boot] = await Promise.all([
        exec("ps", commandArgs, options),
        system.readlink(`/proc/${pid}/cwd`),
        system.readFile("/proc/sys/kernel/random/boot_id"),
      ]);
      const after = await system.readFile(`/proc/${pid}/stat`);
      // Fields after the parenthesized command begin at field 3; field 22 is the start time.
      const start = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const started = start(before);
      if (command.code || !command.stdout.trim() || !boot.trim() || !started || started !== start(after)) return null;
      return { started: `${boot.trim()}/${started}`, command: command.stdout.trim(), cwd };
    }
    if (system.platform === "darwin") {
      const startArgs = ["-p", String(pid), "-o", "lstart="];
      const before = await exec("ps", startArgs, options);
      const [command, cwd] = await Promise.all([
        exec("ps", commandArgs, options),
        exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], options),
      ]);
      const after = await exec("ps", startArgs, options);
      const path = cwd.stdout
        .split("\n")
        .find((line) => line.startsWith("n/"))
        ?.slice(1);
      if (
        before.code ||
        after.code ||
        command.code ||
        cwd.code ||
        !command.stdout.trim() ||
        !before.stdout.trim() ||
        before.stdout.trim() !== after.stdout.trim() ||
        !path
      )
        return null;
      return { started: before.stdout.trim(), command: command.stdout.trim(), cwd: path };
    }
    return null;
  } catch {
    return null;
  }
}
