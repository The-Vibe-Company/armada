import { availableParallelism, totalmem } from "node:os";

export type DockerHostResources = { cpus: number; memoryBytes: number };
export const GIB = 1024 ** 3;

/** Physical defaults; memory is bounded even on machines smaller than the usual allocation. */
export function dockerResourceLimits(resources: DockerHostResources) {
  if (
    !Number.isFinite(resources.cpus) ||
    resources.cpus <= 0 ||
    !Number.isSafeInteger(resources.memoryBytes) ||
    resources.memoryBytes < 6 * 1024 ** 2
  )
    throw new Error("Invalid Docker host resources");
  return { cpus: Math.min(2, resources.cpus), memoryBytes: Math.min(4 * GIB, resources.memoryBytes), pids: 4096 };
}
export function dockerHostResources(): DockerHostResources {
  return { cpus: availableParallelism(), memoryBytes: totalmem() };
}
export function dockerResourceArgs(resources: DockerHostResources): string[] {
  const limits = dockerResourceLimits(resources);
  return [
    "--cpus",
    String(limits.cpus),
    "--memory",
    String(limits.memoryBytes),
    "--memory-swap",
    String(limits.memoryBytes),
    "--pids-limit",
    String(limits.pids),
  ];
}
