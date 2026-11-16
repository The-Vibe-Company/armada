/** Browser-safe disk telemetry. Null free space means the Docker filesystem could not be verified. */
export interface DockerDiskReport {
  freeBytes: number | null;
  floorBytes: number;
}
export const DEFAULT_DOCKER_DISK_FLOOR_BYTES = 10 * 1024 ** 3;
export function validDockerDiskReport(value: unknown): value is DockerDiskReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const disk = value as Record<string, unknown>;
  return (
    Object.keys(disk).length === 2 &&
    Number.isSafeInteger(disk.floorBytes) &&
    Number(disk.floorBytes) >= 0 &&
    (disk.freeBytes === null || (Number.isSafeInteger(disk.freeBytes) && Number(disk.freeBytes) >= 0))
  );
}
export function dockerDiskRefusal(disk: DockerDiskReport | undefined | null): "disk_unavailable" | "disk_full" | null {
  if (!validDockerDiskReport(disk) || disk.freeBytes === null) return "disk_unavailable";
  return disk.freeBytes < disk.floorBytes ? "disk_full" : null;
}
