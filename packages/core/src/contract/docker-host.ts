const DOCKER_HOST_VERSION_STATUSES = ["unknown", "current", "outdated", "ahead"] as const;
export type DockerHostVersionStatus = (typeof DOCKER_HOST_VERSION_STATUSES)[number];

export function isDockerHostVersionStatus(value: unknown): value is DockerHostVersionStatus {
  return DOCKER_HOST_VERSION_STATUSES.some((status) => status === value);
}
