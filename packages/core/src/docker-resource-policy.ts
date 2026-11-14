/** Browser-safe policy, shared by server admission and the host's Docker argv. */
export type DockerHostResources = { cpus: number; memoryBytes: number };
export type DockerResourceOverrides = { cpus?: number; memoryBytes?: number; maxSandboxes?: number };
export type DockerSandboxLimits = { cpus: number; memoryBytes: number; pids: number };
export const GIB = 1024 ** 3;
export function dockerResourceLimits(
  resources: DockerHostResources,
  overrides: DockerResourceOverrides = {},
): DockerSandboxLimits {
  if (
    !Number.isFinite(resources.cpus) ||
    resources.cpus < 0.01 ||
    !Number.isSafeInteger(resources.memoryBytes) ||
    resources.memoryBytes < 6 * 1024 ** 2
  )
    throw new Error("Invalid Docker host resources");
  const cpus = overrides.cpus ?? Math.min(2, resources.cpus);
  const memoryBytes = overrides.memoryBytes ?? Math.min(4 * GIB, resources.memoryBytes);
  if (
    !Number.isFinite(cpus) ||
    cpus < 0.01 ||
    cpus > resources.cpus ||
    !Number.isSafeInteger(memoryBytes) ||
    memoryBytes < 6 * 1024 ** 2 ||
    memoryBytes > resources.memoryBytes
  )
    throw new Error("Sandbox limits must fit the host (CPU at least 0.01; memory at least 6 MiB).");
  return { cpus, memoryBytes, pids: 4096 };
}
export function dockerResourcePolicy(machine: DockerHostResources, overrides: DockerResourceOverrides = {}) {
  const limits = dockerResourceLimits(machine, overrides);
  const cpuCapacity = Math.floor((machine.cpus * 2) / limits.cpus);
  const automatic = Math.max(
    1,
    Math.min(cpuCapacity, Math.floor(Math.max(0, machine.memoryBytes - 2 * GIB) / limits.memoryBytes)),
  );
  const hardCapacity = Math.max(1, Math.min(cpuCapacity, Math.floor(machine.memoryBytes / limits.memoryBytes)));
  if (
    overrides.maxSandboxes !== undefined &&
    (!Number.isSafeInteger(overrides.maxSandboxes) ||
      overrides.maxSandboxes < 1 ||
      overrides.maxSandboxes > hardCapacity)
  )
    throw new Error(`Max sandboxes must be between 1 and ${hardCapacity} for this host and per-sandbox limits.`);
  return {
    machine,
    perSandbox: limits,
    capacity: overrides.maxSandboxes ?? automatic,
    mode: Object.values(overrides).some((value) => value !== undefined) ? ("manual" as const) : ("automatic" as const),
  };
}
export function parseDockerMemory(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|m|g|t|ki?b|mi?b|gi?b|ti?b)?$/i.exec(value.trim());
  if (!match) throw new Error("Memory must be bytes or a size such as 4g or 512m.");
  const unit = (match[2] ?? "b").toLowerCase()[0]!;
  const result = Number(match[1]) * 1024 ** ({ b: 0, k: 1, m: 2, g: 3, t: 4 }[unit] ?? 0);
  if (!Number.isSafeInteger(result) || result < 6 * 1024 ** 2)
    throw new Error("Memory must be at least 6 MiB and an exact byte count.");
  return result;
}
