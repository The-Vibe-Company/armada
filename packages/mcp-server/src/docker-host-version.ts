import { API_FAILURE_HELP, DOCKER_HOST_PROTOCOL, VERSION } from "@armada/core";

const RELEASE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function dockerHostVersionStatus(reported: string | null) {
  const version = reported?.trim();
  if (!version || !RELEASE_VERSION.test(version)) return "unknown";
  try {
    const order = Bun.semver.order(version, VERSION);
    if (order < 0) return "outdated";
    if (order > 0) return "ahead";
    return "current";
  } catch {
    return "unknown";
  }
}

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
