/** Compare the numeric core of published versions; prerelease/build suffixes are metadata,
 * not a reason to hide upgrade guidance on staging, canary or next deployments. */
export function dockerHostUpgradeMessage(
  version: string | null | undefined,
  serverVersion: string | undefined,
): string | null {
  const parse = (value: string | null | undefined) => {
    const match = value && /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(value);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const host = parse(version);
  const server = parse(serverVersion);
  if (!server) return null;
  if (host) {
    const difference = host.findIndex((part, index) => part !== server[index]);
    if (difference === -1 || host[difference]! > server[difference]!) return null;
  }
  return `Docker host daemon ${version ?? "unknown"} ${host ? "is outdated" : "needs a version check"} (server ${serverVersion}). From a signed-in client, run armada host add and run its generated install command on the same Docker machine for the same server. This preserves registration and restarts the user service. Daemons do not upgrade automatically.`;
}
