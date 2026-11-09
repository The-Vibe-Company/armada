import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { groupState, type ProcessIdentity, processIdentity } from "./processes.ts";

/** A crashed runner's detached native children must be gone before replaying
 * private auth. Match only our exact managed home, never argv or token values. */
export async function quiesceNativeCodex(root: string, executable: string): Promise<void> {
  if (process.platform !== "linux") throw Error("native_auth_quiescence_unsupported");
  const home = `CODEX_HOME=${join(root, "codex")}`;
  const groups = new Map<number, ProcessIdentity>();
  const owns = (pid: number) => {
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) return false;
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(home);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      // Desktop/user services may deliberately hide environ. They cannot be a
      // managed native child unless the pinned native executable is in argv.
      if ((error as NodeJS.ErrnoException).code === "EACCES") {
        try {
          if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(executable)) return false;
        } catch {}
      }
      throw Error("native_auth_process_unverifiable");
    }
  };
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name),
      identity = processIdentity(pid);
    if (!identity || !owns(pid)) continue;
    const leader = processIdentity(identity.group);
    if (
      identity.group <= 1 ||
      identity.group === processIdentity(process.pid)?.group ||
      !leader ||
      !owns(identity.group)
    )
      throw Error("native_auth_process_unverifiable");
    if (processIdentity(identity.group)?.start !== leader.start) throw Error("native_auth_process_unverifiable");
    groups.set(identity.group, leader);
  }
  for (const [pid, identity] of groups) {
    if (groupState(pid, identity) === "unverifiable") throw Error("native_auth_process_unverifiable");
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw Error("native_auth_process_unverifiable");
    }
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const states = [...groups].map(([pid, identity]) => groupState(pid, identity));
    if (states.every((state) => state === "gone")) return;
    if (states.includes("unverifiable")) throw Error("native_auth_process_unverifiable");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("native_auth_process_live");
}

/** Private native home only. No returned state is allowed in runner responses or events. */
export function readNativeCodexAuth(root: string, register: (values: readonly string[]) => void): string | undefined {
  let fd: number | undefined;
  try {
    const directory = lstatSync(join(root, "codex"));
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw Error("unsafe");
    fd = openSync(join(root, "codex", "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > 65536 || stat.mode & 0o077)
      throw Error("unsafe");
    const buffer = Buffer.alloc(65537);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) throw Error("oversized");
    const text = buffer.subarray(0, length).toString("utf8");
    const state = JSON.parse(text);
    const leaves = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(leaves)
          : [];
    register([text, ...leaves(state)]);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw Error("native_auth_state_unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
