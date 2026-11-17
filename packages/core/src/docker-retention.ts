/** A Docker sandbox whose host has authorized local cleanup; retrying cannot reclaim its workspace. */
export const DOCKER_RETENTION_ENDED_MESSAGE =
  "This sandbox's local retention cleanup has begun, so its workspace can no longer be resumed. Launch a new sandbox.";

export class DockerRetentionEnded extends Error {
  override readonly name = "DockerRetentionEnded";
  constructor() {
    super(DOCKER_RETENTION_ENDED_MESSAGE);
  }
}
