import { type DockerSnapshotRecord, snapshotUpdateAvailable } from "@armada/core";
import type { DockerHost } from "./docker-hosts";
import { hostBuildBlocker } from "./docker-hosts";
import type { ResourceState } from "./resource-list";

/**
 * A saved artifact remains visible when its installation is offline, but cannot start new work. A draining host
 * is named as such, not as merely unavailable: the uninstall is the thing to finish or retry.
 */
export function snapshotState(
  row: Pick<DockerSnapshotRecord, "status" | "hostAvailable">,
  launchEnabled: boolean,
  hostState?: "pending" | "online" | "offline" | "draining" | "revoked",
): ResourceState {
  if (row.status === "building") return { bucket: "rest", tone: "info", label: "Building" };
  if (row.status === "failed") return { bucket: "action", tone: "destructive", label: "Build failed" };
  if (!row.hostAvailable)
    return { bucket: "rest", tone: "warning", label: hostState === "draining" ? "Host draining" : "Host unavailable" };
  if (!launchEnabled) return { bucket: "rest", tone: "neutral", label: "Launch unavailable" };
  return { bucket: "ready", tone: "success", label: "Ready" };
}

/**
 * The build form's selected host, or the refusal to show. A stale form may still name a host that has since started
 * draining; that reason is the uninstall, not a generic "choose an online host".
 */
export function snapshotBuildHostBlocker(hosts: readonly DockerHost[], hostId: string): string | null {
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!host || host.state === "revoked") return "Choose an online host with snapshot support.";
  return hostBuildBlocker(host);
}

/** Owned-host-only organizations already have a provider: do not send them to cloud onboarding. */
export function hasDockerHost(hosts: readonly { state: string }[]): boolean {
  return hosts.some((host) => host.state !== "revoked");
}

/** Initial affordances follow discovery; actions leave exact retry authority to the server. */
export function snapshotLaunchEnabled(
  option: import("./docker-launch").DockerLaunchOption | null,
  placement: boolean,
): boolean {
  return Boolean(
    placement &&
      option?.enabled &&
      option.capabilities.launch &&
      option.capabilities.goldens &&
      option.launchSources.includes("golden") &&
      option.harnesses.length,
  );
}

/** Older servers omit this field; malformed or non-stable versions cannot advertise an update. */
export function snapshotCurrentVersion(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value : null;
}

/** Rebuilding is additive and restricted to the original private owner or an organization admin. */
export function snapshotRebuildAvailable(
  row: Pick<DockerSnapshotRecord, "status" | "hostAvailable" | "visibility" | "ownerId" | "builtOnVersion">,
  currentVersion: string | null,
  viewer: { id: string; isAdmin: boolean },
  buildEnabled: boolean,
): boolean {
  return Boolean(
    buildEnabled &&
      row.status === "ready" &&
      row.hostAvailable &&
      (row.visibility === "private" ? row.ownerId === viewer.id : viewer.isAdmin) &&
      snapshotUpdateAvailable(row.builtOnVersion, currentVersion),
  );
}
