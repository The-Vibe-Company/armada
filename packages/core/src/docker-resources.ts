import { availableParallelism, totalmem } from "node:os";
import {
  type DockerHostResources,
  type DockerResourceOverrides,
  dockerResourceLimits,
} from "./docker-resource-policy.ts";

export {
  type DockerHostResources,
  type DockerResourceOverrides,
  type DockerSandboxLimits,
  dockerResourceLimits,
  dockerResourcePolicy,
  GIB,
} from "./docker-resource-policy.ts";
export function dockerHostResources(): DockerHostResources {
  return { cpus: availableParallelism(), memoryBytes: totalmem() };
}
export function dockerResourceArgs(resources: DockerHostResources, overrides: DockerResourceOverrides = {}): string[] {
  const limits = dockerResourceLimits(resources, overrides);
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
