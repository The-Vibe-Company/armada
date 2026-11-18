import { dockerHostMeetsVersion, VERSION } from "@armada/core";
import { SNAPSHOT_BASELINE_VERSION } from "@armada/core/server";

// The first published release containing baseline verification (#2641 shipped in v2.55.0).
const baselineRelease = "2.55.0";
export const dockerHostVersions = {
  targetVersion: VERSION,
  // Unstamped source deployments advertise the version they actually ship.
  minimumVersion: dockerHostMeetsVersion(VERSION, baselineRelease) ? baselineRelease : VERSION,
};

export function dockerHostSupportsSnapshotBaseline(
  version: string | null | undefined,
  reportedBaseline: number | null,
): boolean {
  // A source build can advertise support before the version is stamped.
  // Published daemons between #2641 and this change did not send a header.
  return reportedBaseline === null
    ? SNAPSHOT_BASELINE_VERSION === 1 && dockerHostMeetsVersion(version, baselineRelease)
    : reportedBaseline >= SNAPSHOT_BASELINE_VERSION;
}

/** Resume opcode first shipped in 2.28; initial bootstrap remains 2.27 compatible. */
export function dockerHostSupportsResume(value: string | null | undefined): boolean {
  const version = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/);
  const major = Number(version?.[1]);
  const minor = Number(version?.[2]);
  return (
    !!version &&
    Number.isSafeInteger(major) &&
    Number.isSafeInteger(minor) &&
    (major > 2 || (major === 2 && minor >= 28))
  );
}
