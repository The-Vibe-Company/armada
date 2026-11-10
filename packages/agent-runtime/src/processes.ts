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
  if (identity && readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== identity.boot) return "gone";
  // Every exec starts a fresh detached group whose ID is its leader PID. Even if
  // the short-lived leader's birth record was lost, an empty group proves there
  // are no remaining writers. Never infer quiescence from the leader alone.
  const group = identity?.group ?? pid;
  let present = false;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const member = stat(Number(name));
    if (member && member.group === group && member.state !== "Z" && member.state !== "X") {
      present = true;
      break;
    }
  }
  if (!present) return "gone";
  if (!identity) return "unverifiable";
  const leader = stat(pid);
  if (leader && leader.start !== identity.start) return "unverifiable";
  return "live";
}
