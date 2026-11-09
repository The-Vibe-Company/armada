import type { VmResourceReading } from "./resource-observation.ts";

/** Ordered fixed reads, with boot/uptime fencing around the bounded counter read. */
export const VM_RESOURCE_PATHS = [
  "/proc/sys/kernel/random/boot_id",
  "/proc/uptime",
  "/proc/stat",
  "/proc/meminfo",
  "/proc/pressure/cpu",
  "/proc/vmstat",
  "/proc/uptime",
  "/proc/sys/kernel/random/boot_id",
] as const;
export const VM_RESOURCE_MAX_FILE_BYTES = 65536;
function integer(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function uptime(value: string | null | undefined): number | null {
  const token = value?.trim().split(/\s+/)[0];
  if (!token || !/^\d+(?:\.\d+)?$/.test(token)) return null;
  const ms = Number(token) * 1000;
  return Number.isFinite(ms) && ms <= Number.MAX_SAFE_INTEGER ? ms : null;
}
function bootId(value: string | null | undefined): string | null {
  const id = value?.trim();
  return id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? id : null;
}
function cpu(
  value: string | null | undefined,
): Pick<VmResourceReading, "cpuBusyTicks" | "cpuTotalTicks" | "cpuStealTicks" | "cpuLogicalCpus"> {
  const unavailable = { cpuBusyTicks: null, cpuTotalTicks: null, cpuStealTicks: null, cpuLogicalCpus: null };
  const tokens = value
    ?.split("\n")
    .find((line) => /^cpu\s/.test(line))
    ?.trim()
    .split(/\s+/)
    .slice(1, 9);
  if (tokens?.length !== 8) return unavailable;
  const numbers = tokens.map(integer);
  if (numbers.some((number) => number === null)) return unavailable;
  const fields = numbers as number[];
  const cpuTotalTicks = fields.reduce((sum, field) => sum + field, 0);
  // guest and guest_nice are already included in user/nice; steal is not executed work.
  const cpuBusyTicks = [0, 1, 2, 5, 6].reduce((sum, index) => sum + (fields[index] ?? 0), 0);
  if (!Number.isSafeInteger(cpuTotalTicks) || !Number.isSafeInteger(cpuBusyTicks)) return unavailable;
  const cpuIds =
    value?.split("\n").flatMap((line) => {
      const match = line.match(/^cpu(\d+)\s/);
      return match ? [match[1]] : [];
    }) ?? [];
  const cpuLogicalCpus = cpuIds.length > 0 && new Set(cpuIds).size === cpuIds.length ? cpuIds.length : null;
  return { cpuBusyTicks, cpuTotalTicks, cpuStealTicks: fields[7] ?? null, cpuLogicalCpus };
}
function memory(
  value: string | null | undefined,
): Pick<VmResourceReading, "memoryTotalBytes" | "memoryAvailableBytes"> {
  const unavailable = { memoryTotalBytes: null, memoryAvailableBytes: null };
  if (value == null) return unavailable;
  const read = (name: string) => {
    const match = value.match(new RegExp(`^${name}:\\s+(\\d+) kB\\s*$`, "m"));
    const kib = integer(match?.[1]);
    return kib !== null && Number.isSafeInteger(kib * 1024) ? kib * 1024 : null;
  };
  const memoryTotalBytes = read("MemTotal"),
    memoryAvailableBytes = read("MemAvailable");
  if (
    memoryTotalBytes === null ||
    memoryTotalBytes <= 0 ||
    memoryAvailableBytes === null ||
    memoryAvailableBytes > memoryTotalBytes
  )
    return unavailable;
  return { memoryTotalBytes, memoryAvailableBytes };
}
/** Syntax/counter normalization only. These files cannot attest VM scope or effective capacity.
 * Missing counters stay null. Boot crossing, oversized input or invalid time makes the reading unavailable.
 */
export function parseVmResourceFiles(files: readonly (string | null)[]): VmResourceReading | null {
  if (
    files.length !== VM_RESOURCE_PATHS.length ||
    files.some((file) => file !== null && new TextEncoder().encode(file).length >= VM_RESOURCE_MAX_FILE_BYTES)
  )
    return null;
  const start = uptime(files[1]),
    end = uptime(files[6]);
  const beforeBoot = bootId(files[0]),
    afterBoot = bootId(files[7]);
  if (
    beforeBoot === null ||
    beforeBoot !== afterBoot ||
    start === null ||
    end === null ||
    end < start ||
    end - start > 5000
  )
    return null;
  return {
    version: 1,
    bootId: beforeBoot,
    uptimeMs: end,
    captureDurationMs: end - start,
    ...cpu(files[2]),
    ...memory(files[3]),
    cpuPressureSomeUsec: integer(files[4]?.match(/^some\s+.*\btotal=(\d+)\s*$/m)?.[1]),
    oomKills: integer(files[5]?.match(/^oom_kill\s+(\d+)\s*$/m)?.[1]),
  };
}
