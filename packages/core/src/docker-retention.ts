/** A Docker sandbox whose host has authorized local cleanup; retrying cannot reclaim its workspace. */
export const DOCKER_RETENTION_ENDED_MESSAGE =
  "This sandbox's local retention cleanup has begun, so its workspace can no longer be resumed. Launch a new sandbox.";

export class DockerRetentionEnded extends Error {
  override readonly name = "DockerRetentionEnded";
  constructor(reason?: string | null) {
    super(dockerWorkspaceReclaimedMessage(reason) ?? DOCKER_RETENTION_ENDED_MESSAGE);
  }
}

export type DockerCleanupReason = "retention_elapsed" | "disk_pressure";

/** Durable machine cleanup facts, also used by status and resume surfaces. */
export function dockerWorkspaceReclaimedMessage(reason: string | null | undefined): string | null {
  if (reason === "disk_pressure")
    return "Workspace reclaimed because this Docker host was low on disk space. It cannot be resumed. Launch a new sandbox.";
  if (reason === "retention_elapsed")
    return "Workspace reclaimed because its retention period elapsed. It cannot be resumed. Launch a new sandbox.";
  return null;
}
