import type { DockerHostResourceSummary, DockerHostSummary } from "./docker-api.ts";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Additive wire data is still validated before either UI renders it. */
export function validDockerHostResources(value: unknown): value is DockerHostResourceSummary {
  if (!object(value) || !object(value.machine) || !object(value.perSandbox)) return false;
  const { machine, perSandbox, capacity, mode } = value;
  return (
    positive(machine.cpus) &&
    Number.isSafeInteger(machine.memoryBytes) &&
    positive(machine.memoryBytes) &&
    positive(perSandbox.cpus) &&
    perSandbox.cpus <= machine.cpus &&
    Number.isSafeInteger(perSandbox.memoryBytes) &&
    positive(perSandbox.memoryBytes) &&
    perSandbox.memoryBytes <= machine.memoryBytes &&
    Number.isSafeInteger(perSandbox.pids) &&
    positive(perSandbox.pids) &&
    Number.isSafeInteger(capacity) &&
    positive(capacity) &&
    (mode === "automatic" || mode === "manual")
  );
}
const memory = (bytes: number) => `${Number((bytes / 1024 ** 3).toFixed(2))} GiB`;
export function dockerHostResourceDisplay(host: Pick<DockerHostSummary, "resources" | "running">) {
  const resources = host.resources;
  if (!resources)
    return {
      machine: "Unknown — upgrade the host",
      limits: "Unknown — upgrade the host",
      usage: `${host.running ?? "?"}/unknown`,
    };
  return {
    machine: `${resources.machine.cpus} CPUs · ${memory(resources.machine.memoryBytes)} RAM`,
    limits: `${resources.perSandbox.cpus} CPUs · ${memory(resources.perSandbox.memoryBytes)} RAM · ${resources.perSandbox.pids} processes (${resources.mode})`,
    usage: `${host.running ?? "?"}/${resources.capacity}`,
  };
}
