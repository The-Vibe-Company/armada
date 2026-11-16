import type { DockerHostSummary } from "./docker-api.ts";

/** Last reported Docker filesystem headroom, not a promise that a new pull will fit. */
export function dockerHostDiskDisplay(host: Pick<DockerHostSummary, "disk">): string {
  if (!host.disk) return "Unknown — upgrade the host and wait for check-in";
  const gib = (bytes: number) => `${Number((bytes / 1024 ** 3).toFixed(2))} GiB`;
  const floor = `${gib(host.disk.floorBytes)} minimum`;
  if (host.disk.freeBytes === null) return `Unavailable — cannot verify Docker storage (${floor})`;
  return `${gib(host.disk.freeBytes)} free · ${floor}${host.disk.freeBytes < host.disk.floorBytes ? " · launches blocked" : ""}`;
}
