/** Decimal bytes: the owner-approved minimum free space before a Docker launch. */
export const DOCKER_DISK_FLOOR_BYTES = 10_000_000_000;

export function validDockerDiskFreeBytes(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export class DockerDiskFloorError extends Error {
  constructor() {
    super("Docker storage has less than 10 GB free or cannot be measured. Free disk space and retry.");
    this.name = "DockerDiskFloorError";
  }
}

/** Unknown observations fail closed locally; the check must run before pulling an image. */
export function requireDockerDiskSpace(freeBytes: number | null): void {
  if (!validDockerDiskFreeBytes(freeBytes) || freeBytes === null || freeBytes < DOCKER_DISK_FLOOR_BYTES)
    throw new DockerDiskFloorError();
}
