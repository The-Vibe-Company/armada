/** Decimal bytes: the owner-approved minimum free space before a Docker launch. */
export const DOCKER_DISK_FLOOR_BYTES = 10_000_000_000;
export const DOCKER_DISK_FLOOR_MESSAGE =
  "Host disk free space is below the required 10 GB floor or unavailable; free space and retry.";

export function validDockerDiskFreeBytes(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export class DockerDiskFloorError extends Error {
  constructor() {
    super(DOCKER_DISK_FLOOR_MESSAGE);
    this.name = "DockerDiskFloorError";
  }
}

/** Unknown observations fail closed locally; the check must run before pulling an image. */
export function requireDockerDiskSpace(freeBytes: number | null): void {
  if (!validDockerDiskFreeBytes(freeBytes) || freeBytes === null || freeBytes < DOCKER_DISK_FLOOR_BYTES)
    throw new DockerDiskFloorError();
}
