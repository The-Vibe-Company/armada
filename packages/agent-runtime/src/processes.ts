import { readdirSync, readFileSync } from "node:fs";
export interface ProcessIdentity {
  boot: string;
  start: string;
  group: number;
}
function stat(pid: number) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), start: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}
export function processIdentity(pid: number): ProcessIdentity | undefined {
  const value = stat(pid);
  if (!value) return undefined;
  return {
    boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start: value.start,
    group: value.group,
  };
}
/** Never signal a persisted numeric PID: it may now belong to another process. */
export function groupState(pid: number, identity?: ProcessIdentity): "live" | "gone" | "unverifiable" {
  if (!identity) return "unverifiable";
  if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== identity.boot) return "gone";
  const leader = stat(pid);
  if (leader && leader.start !== identity.start) return "unverifiable";
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const member = stat(Number(name));
    if (member && member.group === identity.group && member.state !== "Z" && member.state !== "X") return "live";
  }
  return "gone";
}
