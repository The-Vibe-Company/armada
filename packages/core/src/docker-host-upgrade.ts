/** A header lets upgraded daemons keep using existing poll request bodies on older servers. */
export const DOCKER_HOST_SNAPSHOT_BASELINE_HEADER = "x-armada-snapshot-baseline";

function numericVersion(value: string | null | undefined): number[] | null {
  const match = value && /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(value);
  const parts = match ? match.slice(1, 4).map(Number) : null;
  return parts?.every(Number.isSafeInteger) ? parts : null;
}

/** The numeric release identifies the daemon feature set on staging and stable builds. */
export function dockerHostMeetsVersion(version: string | null | undefined, minimum: string): boolean {
  const host = numericVersion(version);
  const floor = numericVersion(minimum);
  if (!host || !floor) return false;
  const difference = host.findIndex((part, index) => part !== floor[index]);
  return difference === -1 || host[difference]! > floor[difference]!;
}

export function dockerHostUpgradeMessage(
  version: string | null | undefined,
  serverVersion: string | undefined,
  minimumVersion?: string,
  snapshotBuildSupported?: boolean,
): string | null {
  const belowMinimum = minimumVersion && !dockerHostMeetsVersion(version, minimumVersion);
  if (
    snapshotBuildSupported !== false &&
    !belowMinimum &&
    (!serverVersion || !numericVersion(serverVersion) || dockerHostMeetsVersion(version, serverVersion))
  )
    return null;
  const host = numericVersion(version);
  const requirement = belowMinimum
    ? `minimum ${minimumVersion}`
    : snapshotBuildSupported === false
      ? "snapshot baseline support required"
      : `server ${serverVersion}`;
  return `Docker host daemon ${version ?? "unknown"} ${host ? "is outdated" : "needs a version check"} (${requirement}). From a signed-in client, run armada host add and run its generated install command on the same Docker machine for the same server. This preserves registration and restarts the user service. Daemons do not upgrade automatically.`;
}
