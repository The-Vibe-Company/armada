import { API_FAILURE_HELP, DOCKER_HOST_PROTOCOL, VERSION } from "@armada/core";

export class DockerHostUpgradeRequired extends Error {
  readonly code = "docker_host_upgrade_required";

  constructor() {
    super(`${API_FAILURE_HELP.docker_host_upgrade_required} Target daemon release: ${VERSION}.`);
  }
}

export function supportsDockerHostProtocol(protocol: number | null | undefined) {
  return (
    typeof protocol === "number" &&
    Number.isSafeInteger(protocol) &&
    protocol >= DOCKER_HOST_PROTOCOL - 1 &&
    protocol <= DOCKER_HOST_PROTOCOL
  );
}
