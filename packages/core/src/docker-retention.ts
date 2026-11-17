/** A Docker sandbox whose host-local retention deadline passed: its disk is gone and retrying cannot restore it. */
export const DOCKER_RETENTION_ENDED_MESSAGE =
  "This sandbox's local retention period has ended, so its disk was removed. Launch a new sandbox.";

export class DockerRetentionEnded extends Error {
  override readonly name = "DockerRetentionEnded";
  constructor() {
    super(DOCKER_RETENTION_ENDED_MESSAGE);
  }
}
