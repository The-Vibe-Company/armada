import { API_FAILURE_HELP, DOCKER_HOST_PROTOCOL, VERSION } from "@armada/core";

// WARNING: 4.0.0 first shipped protocol 1. Advance this floor when protocol 1 leaves the supported window.
export const dockerHostVersionOffer = { targetVersion: VERSION, minimumVersion: "4.0.0" };

const RELEASE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function dockerHostVersionStatus(reported: string | null, target = VERSION) {
  const version = reported?.trim();
  if (!version || !RELEASE_VERSION.test(version)) return "unknown";
  try {
    const order = Bun.semver.order(version, target);
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
    super(
      `${API_FAILURE_HELP.docker_host_upgrade_required} Minimum daemon release: ${dockerHostVersionOffer.minimumVersion}. Target daemon release: ${dockerHostVersionOffer.targetVersion}.`,
    );
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
